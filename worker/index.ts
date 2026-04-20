import {
  NavigationAPI,
  type LoginRequest,
  type ExportData,
  type Group,
  type Site,
} from '../src/API/http';
import { PreferencesAPI } from './api/preferences';
import { getUserIdentifier } from './utils/userIdentifier';
import { validateFavoriteRequest, validatePreferencesUpdate } from './validation/preferences';

/**
 * 简单的内存速率限制器
 * 注意: 这是基于单个 Worker 实例的内存限制
 * 生产环境建议使用 Cloudflare KV 实现跨实例的速率限制
 */
class SimpleRateLimiter {
  private requests: Map<string, { count: number; resetTime: number }> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number = 5, windowMinutes: number = 15) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMinutes * 60 * 1000;
  }

  private getRecord(identifier: string): { count: number; resetTime: number } | null {
    const now = Date.now();
    const record = this.requests.get(identifier);

    if (record && now > record.resetTime) {
      this.requests.delete(identifier);
      return null;
    }

    return this.requests.get(identifier) || null;
  }

  /**
   * 检查当前标识符是否已经被限制
   */
  isBlocked(identifier: string): boolean {
    const record = this.getRecord(identifier);
    return !!record && record.count >= this.maxRequests;
  }

  /**
   * 记录一次失败尝试
   */
  recordFailure(identifier: string): void {
    const now = Date.now();
    const current = this.getRecord(identifier) || {
      count: 0,
      resetTime: now + this.windowMs,
    };

    current.count++;
    this.requests.set(identifier, current);
  }

  /**
   * 登录成功后清空失败计数
   */
  reset(identifier: string): void {
    this.requests.delete(identifier);
  }

  /**
   * 获取剩余请求次数
   */
  getRemaining(identifier: string): number {
    const record = this.getRecord(identifier);
    if (!record) {
      return this.maxRequests;
    }
    return Math.max(0, this.maxRequests - record.count);
  }

  /**
   * 定期清理过期记录 (避免内存泄漏)
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.requests.entries()) {
      if (now > record.resetTime) {
        this.requests.delete(key);
      }
    }
  }
}

// 创建登录失败速率限制器: 15分钟内最多 5 次失败
const loginRateLimiter = new SimpleRateLimiter(5, 15);

/**
 * 只读路由白名单 - 这些路由在 AUTH_REQUIRED_FOR_READ=false 时无需认证
 */
const READ_ONLY_ROUTES = [
  { method: 'GET', path: '/api/groups' },
  { method: 'GET', path: '/api/sites' },
  { method: 'GET', path: '/api/configs' },
  { method: 'GET', path: '/api/groups-with-sites' },
] as const;

/**
 * 生成唯一错误 ID
 */
function generateErrorId(): string {
  return crypto.randomUUID();
}

/**
 * 结构化日志
 */
interface LogData {
  timestamp?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  errorId?: string;
  path?: string;
  method?: string;
  details?: unknown;
}

function log(data: LogData): void {
  console.log(
    JSON.stringify({
      ...data,
      timestamp: data.timestamp || new Date().toISOString(),
    })
  );
}

/**
 * 创建错误响应
 */
function createErrorResponse(error: unknown, request: Request, context?: string): Response {
  const errorId = generateErrorId();
  const url = new URL(request.url);

  // 记录详细错误日志
  log({
    timestamp: new Date().toISOString(),
    level: 'error',
    message: error instanceof Error ? error.message : '未知错误',
    errorId,
    path: url.pathname,
    method: request.method,
    details:
      error instanceof Error
        ? {
            name: error.name,
            stack: error.stack,
          }
        : error,
  });

  // 返回用户友好的错误信息
  return createJsonResponse(
    {
      success: false,
      message: context ? `${context}失败` : '处理请求时发生错误',
      errorId,
    },
    request,
    { status: 500 }
  );
}

// 请求体大小限制配置
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * 验证请求体大小并解析 JSON
 */
async function validateRequestBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('Content-Length');

  // 检查 Content-Length 头
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    throw new Error('请求体过大，最大允许 1MB');
  }

  // 读取并验证实际大小
  const bodyText = await request.text();

  if (bodyText.length > MAX_BODY_SIZE) {
    throw new Error('请求体过大，最大允许 1MB');
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error('无效的 JSON 格式');
  }
}

/**
 * 深度验证导出数据
 */
function validateExportData(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    errors.push('数据必须是对象');
    return { valid: false, errors };
  }

  const d = data as Record<string, unknown>;

  // 验证 version
  if (!d.version || typeof d.version !== 'string') {
    errors.push('缺少或无效的版本信息');
  }

  // 验证 exportDate
  if (!d.exportDate || typeof d.exportDate !== 'string') {
    errors.push('缺少或无效的导出日期');
  }

  // 验证 groups
  if (!Array.isArray(d.groups)) {
    errors.push('groups 必须是数组');
  } else {
    d.groups.forEach((group: unknown, index: number) => {
      if (!group || typeof group !== 'object') {
        errors.push(`groups[${index}]: 必须是对象`);
        return;
      }
      const g = group as Record<string, unknown>;
      if (!g.name || typeof g.name !== 'string') {
        errors.push(`groups[${index}]: name 必须是字符串`);
      }
      if (typeof g.order_num !== 'number') {
        errors.push(`groups[${index}]: order_num 必须是数字`);
      }
    });
  }

  // 验证 sites
  if (!Array.isArray(d.sites)) {
    errors.push('sites 必须是数组');
  } else {
    d.sites.forEach((site: unknown, index: number) => {
      if (!site || typeof site !== 'object') {
        errors.push(`sites[${index}]: 必须是对象`);
        return;
      }
      const s = site as Record<string, unknown>;
      if (!s.name || typeof s.name !== 'string') {
        errors.push(`sites[${index}]: name 必须是字符串`);
      }
      if (!s.url || typeof s.url !== 'string') {
        errors.push(`sites[${index}]: url 必须是字符串`);
      } else {
        try {
          new URL(s.url);
        } catch {
          errors.push(`sites[${index}]: url 格式无效`);
        }
      }
      if (typeof s.group_id !== 'number') {
        errors.push(`sites[${index}]: group_id 必须是数字`);
      }
      if (typeof s.order_num !== 'number') {
        errors.push(`sites[${index}]: order_num 必须是数字`);
      }
    });
  }

  // 验证 configs
  if (!d.configs || typeof d.configs !== 'object') {
    errors.push('configs 必须是对象');
  }

  return { valid: errors.length === 0, errors };
}

// CORS 配置
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:8788',
  // 生产环境会自动允许同源
];

/**
 * 获取 CORS 头
 */
function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  const requestUrl = new URL(request.url);

  // 如果是同源请求，允许
  let allowedOrigin: string | null = null;

  if (origin) {
    // 检查是否在允许列表中，或者是 workers.dev 子域名
    const isAllowed =
      ALLOWED_ORIGINS.includes(origin) ||
      origin.endsWith('.workers.dev') ||
      origin === requestUrl.origin; // 同源

    allowedOrigin = isAllowed ? origin : null;
  }

  // 如果没有匹配的 origin，使用第一个允许的 origin 或请求源作为默认值
  // 绝不使用通配符 '*'，以增强安全性
  const finalOrigin = allowedOrigin || ALLOWED_ORIGINS[0] || requestUrl.origin;

  return {
    'Access-Control-Allow-Origin': finalOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * 创建带 CORS 头的 JSON 响应
 */
function createJsonResponse(data: unknown, request: Request, options: ResponseInit = {}): Response {
  const corsHeaders = getCorsHeaders(request);

  return Response.json(data, {
    ...options,
    headers: {
      ...corsHeaders,
      ...(options.headers as Record<string, string>),
    },
  });
}

/**
 * 创建带 CORS 头的普通响应
 */
function createResponse(
  body: string | null,
  request: Request,
  options: ResponseInit = {}
): Response {
  const corsHeaders = getCorsHeaders(request);

  return new Response(body, {
    ...options,
    headers: {
      ...corsHeaders,
      ...(options.headers as Record<string, string>),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    // API路由处理
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.replace('/api/', '');
      const method = request.method;

      try {
        const api = new NavigationAPI(env);

        // 登录路由 - 不需要验证
        if (path === 'login' && method === 'POST') {
          try {
            // 速率限制检查
            const clientIP =
              request.headers.get('CF-Connecting-IP') ||
              request.headers.get('X-Forwarded-For') ||
              'unknown';

            if (loginRateLimiter.isBlocked(clientIP)) {
              const remaining = loginRateLimiter.getRemaining(clientIP);
              log({
                level: 'warn',
                message: '登录速率限制触发',
                path: '/api/login',
                method: 'POST',
                details: { clientIP, remaining },
              });

              return createJsonResponse(
                {
                  success: false,
                  message: '登录尝试次数过多，请稍后再试 (15分钟内最多5次)',
                },
                request,
                { status: 429 } // 429 Too Many Requests
              );
            }

            const loginData = (await validateRequestBody(request)) as LoginInput;

            // 验证登录数据
            const validation = validateLogin(loginData);
            if (!validation.valid) {
              return createJsonResponse(
                {
                  success: false,
                  message: `验证失败: ${validation.errors?.join(', ')}`,
                },
                request,
                { status: 400 }
              );
            }

            const result = await api.login(loginData as LoginRequest);

            // 如果登录成功，设置 HttpOnly Cookie
            if (result.success && result.token) {
              loginRateLimiter.reset(clientIP);
              const maxAge = loginData.rememberMe ? 30 * 24 * 60 * 60 : 7 * 24 * 60 * 60;

              return createJsonResponse({ success: true, message: result.message }, request, {
                headers: {
                  'Set-Cookie': [
                    `auth_token=${result.token}`,
                    'HttpOnly',
                    'Secure',
                    'SameSite=Strict',
                    `Max-Age=${maxAge}`,
                    'Path=/',
                  ].join('; '),
                },
              });
            }

            if (result.message === '用户名或密码错误') {
              loginRateLimiter.recordFailure(clientIP);
            }

            return createJsonResponse(result, request);
          } catch (error) {
            return createJsonResponse(
              {
                success: false,
                message: error instanceof Error ? error.message : '请求无效',
              },
              request,
              { status: 400 }
            );
          }
        }

        // 登出路由
        if (path === 'logout' && method === 'POST') {
          return createJsonResponse({ success: true, message: '登出成功' }, request, {
            headers: {
              'Set-Cookie': [
                'auth_token=',
                'HttpOnly',
                'Secure',
                'SameSite=Strict',
                'Max-Age=0',
                'Path=/',
              ].join('; '),
            },
          });
        }

        // 认证状态检查端点 - 检查当前用户是否已认证
        if (path === 'auth/status' && method === 'GET') {
          // 检查 Cookie 中的 token
          const cookieHeader = request.headers.get('Cookie');
          let token: string | null = null;

          if (cookieHeader) {
            const cookies = cookieHeader.split(';').reduce(
              (acc, cookie) => {
                const [key, value] = cookie.trim().split('=');
                if (key && value) {
                  acc[key] = value;
                }
                return acc;
              },
              {} as Record<string, string>
            );

            token = cookies['auth_token'] || null;
          }

          // 验证 token
          if (token && api.isAuthEnabled()) {
            try {
              const result = await api.verifyToken(token);
              return createJsonResponse({ authenticated: result.valid }, request);
            } catch {
              return createJsonResponse({ authenticated: false }, request);
            }
          }

          // 没有 token 或认证未启用
          return createJsonResponse({ authenticated: false }, request);
        }

        // 初始化数据库接口 - 不需要验证
        if (path === 'init' && method === 'GET') {
          const initResult = await api.initDB();
          if (initResult.alreadyInitialized) {
            return createResponse('数据库已经初始化过，无需重复初始化', request, { status: 200 });
          }
          return createResponse('数据库初始化成功', request, { status: 200 });
        }

        // 验证中间件 - 条件认证
        let isAuthenticated = false; // 记录认证状态

        if (api.isAuthEnabled()) {
          const requestPath = `/api/${path}`;

          // 检查是否为只读路由且免认证已启用
          const isReadOnlyRoute = READ_ONLY_ROUTES.some(
            (route) => route.method === method && route.path === requestPath
          );

          const shouldRequireAuth = !isReadOnlyRoute || env.AUTH_REQUIRED_FOR_READ === 'true';

          // 总是检查 token（如果存在）
          const cookieHeader = request.headers.get('Cookie');
          let token: string | null = null;

          if (cookieHeader) {
            const cookies = cookieHeader.split(';').reduce(
              (acc, cookie) => {
                const [key, value] = cookie.trim().split('=');
                if (key) {
                  acc[key] = value || '';
                }
                return acc;
              },
              {} as Record<string, string>
            );

            token = cookies['auth_token'] || null;
          }

          // 如果 Cookie 中没有，尝试从 Authorization 头读取（向后兼容）
          if (!token) {
            const authHeader = request.headers.get('Authorization');
            if (authHeader) {
              const [authType, headerToken] = authHeader.split(' ');
              if (authType === 'Bearer' && headerToken) {
                token = headerToken;
              }
            }
          }

          // 如果有 token，验证它
          if (token) {
            try {
              const verifyResult = await api.verifyToken(token);
              if (verifyResult.valid) {
                isAuthenticated = true; // 认证成功
                log({
                  timestamp: new Date().toISOString(),
                  level: 'info',
                  message: `已认证用户访问: ${method} ${requestPath}`,
                });
              }
            } catch (error) {
              // Token 验证失败，保持 isAuthenticated = false
              log({
                timestamp: new Date().toISOString(),
                level: 'warn',
                message: `Token 验证失败: ${method} ${requestPath}`,
                details: error,
              });
            }
          }

          // 如果需要强制认证但未认证，返回 401
          if (shouldRequireAuth && !isAuthenticated) {
            return createResponse('请先登录', request, {
              status: 401,
              headers: {
                'WWW-Authenticate': 'Bearer',
              },
            });
          }

          // 记录访客访问（只读路由且未认证）
          if (isReadOnlyRoute && !isAuthenticated) {
            log({
              timestamp: new Date().toISOString(),
              level: 'info',
              message: `访客模式访问: ${method} ${requestPath}`,
            });
          }
        }

        // 路由匹配
        // GET /api/groups-with-sites 获取所有分组及其站点 (优化 N+1 查询)
        if (path === 'groups-with-sites' && method === 'GET') {
          const groupsWithSites = await api.getGroupsWithSites();

          // 根据认证状态过滤数据
          if (!isAuthenticated) {
            // 未认证用户只能看到公开分组下的公开站点
            const filteredGroups = groupsWithSites
              .filter((group) => group.is_public === 1)
              .map((group) => ({
                ...group,
                sites: group.sites.filter((site) => site.is_public === 1),
              }));
            return createJsonResponse(filteredGroups, request);
          }

          return createJsonResponse(groupsWithSites, request);
        }
        // GET /api/groups 获取所有分组
        else if (path === 'groups' && method === 'GET') {
          // 根据认证状态过滤查询
          let query = 'SELECT * FROM groups';
          const params: number[] = [];

          if (!isAuthenticated) {
            // 未认证用户只能看到公开分组
            query += ' WHERE is_public = ?';
            params.push(1);
          }

          query += ' ORDER BY order_num ASC';

          const result = await env.DB.prepare(query)
            .bind(...params)
            .all();
          return createJsonResponse(result.results || [], request);
        } else if (path.startsWith('groups/') && method === 'GET') {
          const idStr = path.split('/')[1];
          if (!idStr) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }
          const id = parseInt(idStr);
          if (isNaN(id)) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }
          const group = await api.getGroup(id);
          return createJsonResponse(group, request);
        } else if (path === 'groups' && method === 'POST') {
          const data = (await validateRequestBody(request)) as GroupInput;

          // 验证分组数据
          const validation = validateGroup(data);
          if (!validation.valid) {
            return createJsonResponse(
              {
                success: false,
                message: `验证失败: ${validation.errors?.join(', ')}`,
              },
              request,
              { status: 400 }
            );
          }

          const result = await api.createGroup(validation.sanitizedData as Group);
          return createJsonResponse(result, request);
        } else if (path.startsWith('groups/') && method === 'PUT') {
          const idStr = path.split('/')[1];
          if (!idStr) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }
          const id = parseInt(idStr);
          if (isNaN(id)) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }

          const data = (await validateRequestBody(request)) as Partial<Group>;
          // 对修改的字段进行验证
          if (
            data.name !== undefined &&
            (typeof data.name !== 'string' || data.name.trim() === '')
          ) {
            return createJsonResponse(
              {
                success: false,
                message: '分组名称不能为空且必须是字符串',
              },
              request,
              { status: 400 }
            );
          }

          if (data.order_num !== undefined && typeof data.order_num !== 'number') {
            return createJsonResponse(
              {
                success: false,
                message: '排序号必须是数字',
              },
              request,
              { status: 400 }
            );
          }

          const result = await api.updateGroup(id, data);
          return createJsonResponse(result, request);
        } else if (path.startsWith('groups/') && method === 'DELETE') {
          const idStr = path.split('/')[1];
          if (!idStr) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }
          const id = parseInt(idStr);
          if (isNaN(id)) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }

          const result = await api.deleteGroup(id);
          return createJsonResponse({ success: result }, request);
        }
        // 站点相关API
        else if (path === 'sites' && method === 'GET') {
          // 根据认证状态过滤查询
          let query = `
                        SELECT s.*
                        FROM sites s
                        INNER JOIN groups g ON s.group_id = g.id
                    `;

          const groupId = url.searchParams.get('groupId');
          const conditions: string[] = [];
          const params: (string | number)[] = [];

          // 添加 groupId 过滤条件
          if (groupId) {
            conditions.push(`s.group_id = ?`);
            params.push(parseInt(groupId));
          }

          // 未认证用户只能看到公开分组下的公开网站
          if (!isAuthenticated) {
            conditions.push('g.is_public = ?');
            params.push(1);
            conditions.push('s.is_public = ?');
            params.push(1);
          }

          if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
          }

          query += ' ORDER BY s.group_id ASC, s.order_num ASC';

          const result = await env.DB.prepare(query)
            .bind(...params)
            .all();
          return createJsonResponse(result.results || [], request);
        } else if (path.startsWith('sites/') && method === 'GET') {
          const idStr = path.split('/')[1];
          if (!idStr) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }
          const id = parseInt(idStr);
          if (isNaN(id)) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }

          const site = await api.getSite(id);
          return createJsonResponse(site, request);
        } else if (path === 'sites' && method === 'POST') {
          const data = (await validateRequestBody(request)) as SiteInput;

          // 验证站点数据
          const validation = validateSite(data);
          if (!validation.valid) {
            return createJsonResponse(
              {
                success: false,
                message: `验证失败: ${validation.errors?.join(', ')}`,
              },
              request,
              { status: 400 }
            );
          }

          const result = await api.createSite(validation.sanitizedData as Site);
          return createJsonResponse(result, request);
        } else if (path.startsWith('sites/') && method === 'PUT') {
          const idStr = path.split('/')[1];
          if (!idStr) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }
          const id = parseInt(idStr);
          if (isNaN(id)) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }

          const data = (await validateRequestBody(request)) as Partial<Site>;

          // 验证更新的站点数据
          if (data.url !== undefined) {
            let url = data.url.trim();
            // 如果没有协议,自动添加 https://
            if (!/^https?:\/\//i.test(url)) {
              url = 'https://' + url;
            }
            try {
              new URL(url);
              data.url = url; // 使用修正后的URL
            } catch {
              return createJsonResponse(
                {
                  success: false,
                  message: '无效的URL格式',
                },
                request,
                { status: 400 }
              );
            }
          }

          if (data.icon !== undefined && data.icon !== '') {
            let iconUrl = data.icon.trim();
            // 如果没有协议,自动添加 https://
            if (!/^https?:\/\//i.test(iconUrl) && !/^data:/i.test(iconUrl)) {
              iconUrl = 'https://' + iconUrl;
            }
            try {
              new URL(iconUrl);
              data.icon = iconUrl; // 使用修正后的URL
            } catch {
              return createJsonResponse(
                {
                  success: false,
                  message: '无效的图标URL格式',
                },
                request,
                { status: 400 }
              );
            }
          }

          const result = await api.updateSite(id, data);
          return createJsonResponse(result, request);
        } else if (path.startsWith('sites/') && method === 'DELETE') {
          const idStr = path.split('/')[1];
          if (!idStr) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }
          const id = parseInt(idStr);
          if (isNaN(id)) {
            return createJsonResponse({ error: '无效的ID' }, request, { status: 400 });
          }

          const result = await api.deleteSite(id);
          return createJsonResponse({ success: result }, request);
        }
        // 批量更新排序
        else if (path === 'group-orders' && method === 'PUT') {
          const data = (await validateRequestBody(request)) as Array<{
            id: number;
            order_num: number;
          }>;

          // 验证排序数据
          if (!Array.isArray(data)) {
            return createJsonResponse(
              {
                success: false,
                message: '排序数据必须是数组',
              },
              request,
              { status: 400 }
            );
          }

          for (const item of data) {
            if (
              !item.id ||
              typeof item.id !== 'number' ||
              item.order_num === undefined ||
              typeof item.order_num !== 'number'
            ) {
              return createJsonResponse(
                {
                  success: false,
                  message: '排序数据格式无效，每个项目必须包含id和order_num',
                },
                request,
                { status: 400 }
              );
            }
          }

          const result = await api.updateGroupOrder(data);
          return createJsonResponse({ success: result }, request);
        } else if (path === 'site-orders' && method === 'PUT') {
          const data = (await validateRequestBody(request)) as Array<{
            id: number;
            order_num: number;
          }>;

          // 验证排序数据
          if (!Array.isArray(data)) {
            return createJsonResponse(
              {
                success: false,
                message: '排序数据必须是数组',
              },
              request,
              { status: 400 }
            );
          }

          for (const item of data) {
            if (
              !item.id ||
              typeof item.id !== 'number' ||
              item.order_num === undefined ||
              typeof item.order_num !== 'number'
            ) {
              return createJsonResponse(
                {
                  success: false,
                  message: '排序数据格式无效，每个项目必须包含id和order_num',
                },
                request,
                { status: 400 }
              );
            }
          }

          const result = await api.updateSiteOrder(data);
          return createJsonResponse({ success: result }, request);
        }
        // 配置相关API
        else if (path === 'configs' && method === 'GET') {
          const configs = await api.getConfigs();
          return createJsonResponse(configs, request);
        } else if (path.startsWith('configs/') && method === 'GET') {
          const key = path.substring('configs/'.length);
          const value = await api.getConfig(key);
          return createJsonResponse({ key, value }, request);
        } else if (path.startsWith('configs/') && method === 'PUT') {
          const key = path.substring('configs/'.length);
          const data = (await validateRequestBody(request)) as ConfigInput;

          // 验证配置数据
          const validation = validateConfig(data);
          if (!validation.valid) {
            return createJsonResponse(
              {
                success: false,
                message: `验证失败: ${validation.errors?.join(', ')}`,
              },
              request,
              { status: 400 }
            );
          }

          // 确保value存在
          if (data.value === undefined) {
            return createJsonResponse(
              {
                success: false,
                message: '配置值必须提供，可以为空字符串',
              },
              request,
              { status: 400 }
            );
          }

          const result = await api.setConfig(key, data.value);
          return createJsonResponse({ success: result }, request);
        } else if (path.startsWith('configs/') && method === 'DELETE') {
          const key = path.substring('configs/'.length);
          const result = await api.deleteConfig(key);
          return createJsonResponse({ success: result }, request);
        }

        // 数据导出路由
        else if (path === 'export' && method === 'GET') {
          const data = await api.exportData();
          return createJsonResponse(data, request, {
            headers: {
              'Content-Disposition': 'attachment; filename=navhive-data.json',
              'Content-Type': 'application/json',
            },
          });
        }

        // 数据导入路由
        else if (path === 'import' && method === 'POST') {
          const data = await validateRequestBody(request);

          // 深度验证导入数据
          const validation = validateExportData(data);
          if (!validation.valid) {
            return createJsonResponse(
              {
                success: false,
                message: '导入数据验证失败',
                errors: validation.errors,
              },
              request,
              { status: 400 }
            );
          }

          const result = await api.importData(data as ExportData);
          return createJsonResponse(result, request);
        }

        // 偏好设置 API 路由
        // 获取用户标识符（已认证用户或游客）
        const prefsAPI = new PreferencesAPI(env.DB);
        const { userId } = await getUserIdentifier(request, api);

        // GET /api/preferences/favorites - 获取收藏列表
        if (path === 'preferences/favorites' && method === 'GET') {
          try {
            const favorites = await prefsAPI.getFavorites(userId);
            return createJsonResponse({ favorites }, request);
          } catch (error) {
            return createErrorResponse(error, request, '获取收藏列表');
          }
        }

        // POST /api/preferences/favorites/:siteId - 添加收藏
        else if (path.startsWith('preferences/favorites/') && method === 'POST') {
          const siteIdStr = path.split('/')[2];
          const validation = validateFavoriteRequest(siteIdStr);

          if (!validation.valid) {
            return createJsonResponse(
              {
                success: false,
                message: `验证失败: ${validation.errors?.join(', ')}`,
              },
              request,
              { status: 400 }
            );
          }

          try {
            await prefsAPI.addFavorite(userId, validation.sanitizedData!);
            return createJsonResponse({ success: true, message: '收藏成功' }, request);
          } catch (error) {
            if (error instanceof Error && error.message === '该站点已在收藏列表中') {
              return createJsonResponse({ success: false, message: error.message }, request, {
                status: 409,
              });
            }
            if (error instanceof Error && error.message === '站点不存在') {
              return createJsonResponse({ success: false, message: error.message }, request, {
                status: 404,
              });
            }
            return createErrorResponse(error, request, '添加收藏');
          }
        }

        // DELETE /api/preferences/favorites/:siteId - 删除收藏
        else if (path.startsWith('preferences/favorites/') && method === 'DELETE') {
          const siteIdStr = path.split('/')[2];
          const validation = validateFavoriteRequest(siteIdStr);

          if (!validation.valid) {
            return createJsonResponse(
              {
                success: false,
                message: `验证失败: ${validation.errors?.join(', ')}`,
              },
              request,
              { status: 400 }
            );
          }

          try {
            await prefsAPI.removeFavorite(userId, validation.sanitizedData!);
            return createJsonResponse({ success: true, message: '取消收藏成功' }, request);
          } catch (error) {
            return createErrorResponse(error, request, '删除收藏');
          }
        }

        // GET /api/preferences/settings - 获取用户偏好设置
        else if (path === 'preferences/settings' && method === 'GET') {
          try {
            const preferences = await prefsAPI.getPreferences(userId);
            return createJsonResponse({ preferences }, request);
          } catch (error) {
            return createErrorResponse(error, request, '获取偏好设置');
          }
        }

        // PUT /api/preferences/settings - 更新用户偏好设置
        else if (path === 'preferences/settings' && method === 'PUT') {
          const data = await validateRequestBody(request);
          const validation = validatePreferencesUpdate(data);

          if (!validation.valid) {
            return createJsonResponse(
              {
                success: false,
                message: `验证失败: ${validation.errors?.join(', ')}`,
              },
              request,
              { status: 400 }
            );
          }

          try {
            await prefsAPI.updatePreferences(userId, validation.sanitizedData!);
            return createJsonResponse({ success: true, message: '偏好设置已更新' }, request);
          } catch (error) {
            return createErrorResponse(error, request, '更新偏好设置');
          }
        }

        // POST /api/preferences/visits/:siteId - 记录站点访问
        else if (path.startsWith('preferences/visits/') && method === 'POST') {
          const siteIdStr = path.split('/')[2];
          const validation = validateFavoriteRequest(siteIdStr);

          if (!validation.valid) {
            return createJsonResponse(
              {
                success: false,
                message: `验证失败: ${validation.errors?.join(', ')}`,
              },
              request,
              { status: 400 }
            );
          }

          try {
            await prefsAPI.recordVisit(userId, validation.sanitizedData!);
            return createJsonResponse({ success: true }, request);
          } catch (error) {
            return createErrorResponse(error, request, '记录访问');
          }
        }

        // GET /api/preferences/visits - 获取最近访问
        else if (path === 'preferences/visits' && method === 'GET') {
          try {
            const limitStr = url.searchParams.get('limit');
            const limit = limitStr ? parseInt(limitStr, 10) : 20;

            if (isNaN(limit) || limit < 1) {
              return createJsonResponse(
                {
                  success: false,
                  message: 'limit 参数必须是正整数',
                },
                request,
                { status: 400 }
              );
            }

            const visits = await prefsAPI.getRecentVisits(userId, limit);
            return createJsonResponse({ visits }, request);
          } catch (error) {
            return createErrorResponse(error, request, '获取访问记录');
          }
        }

        // POST /api/preferences/migrate - 迁移游客偏好数据
        else if (path === 'preferences/migrate' && method === 'POST') {
          // 必须是已认证用户才能迁移
          if (!isAuthenticated) {
            return createJsonResponse(
              {
                success: false,
                message: '必须登录后才能迁移数据',
              },
              request,
              { status: 401 }
            );
          }

          const data = await validateRequestBody(request);

          if (!data || typeof data !== 'object' || !('device_identifier' in data)) {
            return createJsonResponse(
              {
                success: false,
                message: '缺少 device_identifier 参数',
              },
              request,
              { status: 400 }
            );
          }

          const deviceId = (data as { device_identifier: unknown }).device_identifier;

          if (typeof deviceId !== 'string' || !deviceId.startsWith('guest_')) {
            return createJsonResponse(
              {
                success: false,
                message: '无效的 device_identifier 格式',
              },
              request,
              { status: 400 }
            );
          }

          try {
            const migrated = await prefsAPI.migrateGuestData(deviceId, userId);
            return createJsonResponse(
              {
                success: true,
                message: '偏好数据迁移成功',
                migrated,
              },
              request
            );
          } catch (error) {
            return createErrorResponse(error, request, '迁移偏好数据');
          }
        }

        // 默认返回404
        return createResponse('API路径不存在', request, { status: 404 });
      } catch (error) {
        return createErrorResponse(error, request, 'API 请求');
      }
    }

    // 非API路由默认返回404
    return createResponse('Not Found', request, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// 环境变量接口
interface Env {
  DB: D1Database;
  AUTH_ENABLED?: string;
  AUTH_REQUIRED_FOR_READ?: string;
  AUTH_USERNAME?: string;
  AUTH_PASSWORD?: string;
  AUTH_SECRET?: string;
}

// 验证用接口
interface LoginInput {
  username?: string;
  password?: string;
  rememberMe?: boolean;
}

interface GroupInput {
  name?: string;
  order_num?: number;
  is_public?: number;
}

interface SiteInput {
  group_id?: number;
  name?: string;
  url?: string;
  icon?: string;
  description?: string;
  notes?: string;
  order_num?: number;
  is_public?: number;
}

interface ConfigInput {
  value?: string;
}

// 输入验证函数
function validateLogin(data: LoginInput): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!data.username || typeof data.username !== 'string') {
    errors.push('用户名不能为空且必须是字符串');
  }

  if (!data.password || typeof data.password !== 'string') {
    errors.push('密码不能为空且必须是字符串');
  }

  if (data.rememberMe !== undefined && typeof data.rememberMe !== 'boolean') {
    errors.push('记住我选项必须是布尔值');
  }

  return { valid: errors.length === 0, errors };
}

function validateGroup(data: GroupInput): {
  valid: boolean;
  errors?: string[];
  sanitizedData?: Group;
} {
  const errors: string[] = [];
  const sanitizedData: Partial<Group> = {};

  // 验证名称
  if (!data.name || typeof data.name !== 'string') {
    errors.push('分组名称不能为空且必须是字符串');
  } else {
    sanitizedData.name = data.name.trim().slice(0, 100); // 限制长度
  }

  // 验证排序号
  if (data.order_num === undefined || typeof data.order_num !== 'number') {
    errors.push('排序号必须是数字');
  } else {
    sanitizedData.order_num = data.order_num;
  }

  // 验证 is_public (可选，默认为 1 - 公开)
  if (data.is_public !== undefined) {
    if (typeof data.is_public === 'number' && (data.is_public === 0 || data.is_public === 1)) {
      sanitizedData.is_public = data.is_public;
    } else {
      errors.push('is_public 必须是 0 (私密) 或 1 (公开)');
    }
  } else {
    sanitizedData.is_public = 1; // 默认公开
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedData: errors.length === 0 ? (sanitizedData as Group) : undefined,
  };
}

function validateSite(data: SiteInput): {
  valid: boolean;
  errors?: string[];
  sanitizedData?: Site;
} {
  const errors: string[] = [];
  const sanitizedData: Partial<Site> = {};

  // 验证分组ID
  if (!data.group_id || typeof data.group_id !== 'number') {
    errors.push('分组ID必须是数字且不能为空');
  } else {
    sanitizedData.group_id = data.group_id;
  }

  // 验证名称
  if (!data.name || typeof data.name !== 'string') {
    errors.push('站点名称不能为空且必须是字符串');
  } else {
    sanitizedData.name = data.name.trim().slice(0, 100); // 限制长度
  }

  // 验证URL
  if (!data.url || typeof data.url !== 'string') {
    errors.push('URL不能为空且必须是字符串');
  } else {
    let url = data.url.trim();
    // 如果没有协议,自动添加 https://
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    try {
      // 验证URL格式
      new URL(url);
      sanitizedData.url = url;
    } catch {
      errors.push('无效的URL格式');
    }
  }

  // 验证图标URL (可选)
  if (data.icon !== undefined) {
    if (typeof data.icon !== 'string') {
      errors.push('图标URL必须是字符串');
    } else if (data.icon) {
      let iconUrl = data.icon.trim();
      // 如果没有协议,自动添加 https://
      if (!/^https?:\/\//i.test(iconUrl) && !/^data:/i.test(iconUrl)) {
        iconUrl = 'https://' + iconUrl;
      }
      try {
        // 验证URL格式
        new URL(iconUrl);
        sanitizedData.icon = iconUrl;
      } catch {
        errors.push('无效的图标URL格式');
      }
    } else {
      sanitizedData.icon = '';
    }
  }

  // 验证描述 (可选)
  if (data.description !== undefined) {
    sanitizedData.description =
      typeof data.description === 'string'
        ? data.description.trim().slice(0, 500) // 限制长度
        : '';
  }

  // 验证备注 (可选)
  if (data.notes !== undefined) {
    sanitizedData.notes =
      typeof data.notes === 'string'
        ? data.notes.trim().slice(0, 1000) // 限制长度
        : '';
  }

  // 验证排序号
  if (data.order_num === undefined || typeof data.order_num !== 'number') {
    errors.push('排序号必须是数字');
  } else {
    sanitizedData.order_num = data.order_num;
  }

  // 验证 is_public (可选，默认为 1 - 公开)
  if (data.is_public !== undefined) {
    if (typeof data.is_public === 'number' && (data.is_public === 0 || data.is_public === 1)) {
      sanitizedData.is_public = data.is_public;
    } else {
      errors.push('is_public 必须是 0 (私密) 或 1 (公开)');
    }
  } else {
    sanitizedData.is_public = 1; // 默认公开
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedData: errors.length === 0 ? (sanitizedData as Site) : undefined,
  };
}

function validateConfig(data: ConfigInput): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (data.value === undefined || typeof data.value !== 'string') {
    errors.push('配置值必须是字符串类型');
  }

  return { valid: errors.length === 0, errors };
}

// ExecutionContext and ExportedHandler types are now provided by worker-configuration.d.ts (generated by wrangler types)

// D1Database types are now provided by worker-configuration.d.ts (generated by wrangler types)
