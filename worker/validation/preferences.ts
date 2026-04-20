/**
 * 偏好设置输入验证工具
 *
 * 提供用户偏好相关请求的输入验证和数据清理功能
 */

// 验证结果接口
interface ValidationResult<T = unknown> {
  valid: boolean;
  errors?: string[];
  sanitizedData?: T;
}

// 用户偏好设置接口
interface UserPreferences {
  view_mode?: 'card' | 'list';
  theme_mode?: 'light' | 'dark';
  custom_colors?: string | null;
}

/**
 * 验证收藏请求
 *
 * @param siteId - 站点ID（未知类型，需要验证）
 * @returns 验证结果，包含是否有效、错误信息和清理后的数据
 *
 * 需求: 8.2 - 输入验证
 */
export function validateFavoriteRequest(siteId: unknown): ValidationResult<number> {
  const errors: string[] = [];
  let sanitizedSiteId: number | undefined;

  // 验证 siteId 存在
  if (siteId === undefined || siteId === null) {
    errors.push('站点ID不能为空');
    return { valid: false, errors };
  }

  // 验证 siteId 类型
  if (typeof siteId === 'number') {
    sanitizedSiteId = siteId;
  } else if (typeof siteId === 'string') {
    // 尝试转换字符串为数字
    const parsed = parseInt(siteId, 10);
    if (isNaN(parsed)) {
      errors.push('站点ID必须是有效的数字');
    } else {
      sanitizedSiteId = parsed;
    }
  } else {
    errors.push('站点ID必须是数字');
  }

  // 验证 siteId 为正整数
  if (sanitizedSiteId !== undefined) {
    if (!Number.isInteger(sanitizedSiteId)) {
      errors.push('站点ID必须是整数');
    } else if (sanitizedSiteId <= 0) {
      errors.push('站点ID必须是正整数');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    sanitizedData: errors.length === 0 ? sanitizedSiteId : undefined,
  };
}

/**
 * 验证偏好设置更新请求
 *
 * @param data - 偏好设置数据（未知类型，需要验证）
 * @returns 验证结果，包含是否有效、错误信息和清理后的数据
 *
 * 需求: 8.2 - 输入验证
 * 需求: 3.2 - 视图模式必须是 'card' 或 'list'
 * 需求: 3.3 - 主题模式必须是 'light' 或 'dark'
 */
export function validatePreferencesUpdate(data: unknown): ValidationResult<UserPreferences> {
  const errors: string[] = [];
  const sanitizedData: UserPreferences = {};

  // 验证数据是对象
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push('偏好设置数据必须是对象');
    return { valid: false, errors };
  }

  const input = data as Record<string, unknown>;

  // 验证 view_mode (可选)
  if (input.view_mode !== undefined) {
    if (typeof input.view_mode !== 'string') {
      errors.push('视图模式必须是字符串');
    } else if (input.view_mode !== 'card' && input.view_mode !== 'list') {
      errors.push("视图模式必须是 'card' 或 'list'");
    } else {
      sanitizedData.view_mode = input.view_mode as 'card' | 'list';
    }
  }

  // 验证 theme_mode (可选)
  if (input.theme_mode !== undefined) {
    if (typeof input.theme_mode !== 'string') {
      errors.push('主题模式必须是字符串');
    } else if (input.theme_mode !== 'light' && input.theme_mode !== 'dark') {
      errors.push("主题模式必须是 'light' 或 'dark'");
    } else {
      sanitizedData.theme_mode = input.theme_mode as 'light' | 'dark';
    }
  }

  // 验证 custom_colors (可选)
  if (input.custom_colors !== undefined) {
    if (input.custom_colors === null) {
      // null 是有效值，表示清除自定义颜色
      sanitizedData.custom_colors = null;
    } else if (typeof input.custom_colors === 'string') {
      // 验证是否为有效的 JSON
      try {
        const parsed = JSON.parse(input.custom_colors);
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          errors.push('自定义颜色必须是有效的 JSON 对象');
        } else {
          // 验证 JSON 对象的结构（可选的颜色字段）
          const validKeys = ['primary', 'secondary', 'background', 'surface', 'text'];
          const parsedKeys = Object.keys(parsed);

          // 检查是否有无效的键
          const invalidKeys = parsedKeys.filter((key) => !validKeys.includes(key));
          if (invalidKeys.length > 0) {
            errors.push(`自定义颜色包含无效的字段: ${invalidKeys.join(', ')}`);
          }

          // 检查所有值是否为字符串
          const nonStringValues = parsedKeys.filter((key) => typeof parsed[key] !== 'string');
          if (nonStringValues.length > 0) {
            errors.push('自定义颜色的所有值必须是字符串');
          }

          if (invalidKeys.length === 0 && nonStringValues.length === 0) {
            sanitizedData.custom_colors = input.custom_colors;
          }
        }
      } catch {
        errors.push('自定义颜色必须是有效的 JSON 格式');
      }
    } else if (typeof input.custom_colors === 'object' && !Array.isArray(input.custom_colors)) {
      // 如果传入的是对象，转换为 JSON 字符串
      try {
        const validKeys = ['primary', 'secondary', 'background', 'surface', 'text'];
        const inputKeys = Object.keys(input.custom_colors);

        // 检查是否有无效的键
        const invalidKeys = inputKeys.filter((key) => !validKeys.includes(key));
        if (invalidKeys.length > 0) {
          errors.push(`自定义颜色包含无效的字段: ${invalidKeys.join(', ')}`);
        }

        // 检查所有值是否为字符串
        const nonStringValues = inputKeys.filter(
          (key) => typeof (input.custom_colors as Record<string, unknown>)[key] !== 'string'
        );
        if (nonStringValues.length > 0) {
          errors.push('自定义颜色的所有值必须是字符串');
        }

        if (invalidKeys.length === 0 && nonStringValues.length === 0) {
          sanitizedData.custom_colors = JSON.stringify(input.custom_colors);
        }
      } catch {
        errors.push('自定义颜色对象无法序列化为 JSON');
      }
    } else {
      errors.push('自定义颜色必须是 JSON 字符串、对象或 null');
    }
  }

  // 确保至少有一个字段被更新
  if (Object.keys(sanitizedData).length === 0 && errors.length === 0) {
    errors.push('至少需要提供一个偏好设置字段进行更新');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    sanitizedData: errors.length === 0 ? sanitizedData : undefined,
  };
}
