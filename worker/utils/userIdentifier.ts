/**
 * User Identifier Resolution Utilities
 *
 * Provides functions for resolving user identifiers from authenticated users
 * or guest device identifiers, supporting both authenticated and guest user workflows.
 */

import { NavigationAPI } from '../../src/API/http';
import { getDeviceIdentifier, generateDeviceIdentifier } from './deviceIdentifier';

/**
 * User identifier result
 */
export interface UserIdentifierResult {
  userId: string;
  isGuest: boolean;
}

/**
 * Extract auth token from request
 *
 * Priority:
 * 1. auth_token cookie
 * 2. Authorization Bearer header (backward compatibility)
 *
 * @param request - The incoming HTTP request
 * @returns Auth token string or null if not found
 */
function getAuthToken(request: Request): string | null {
  // Priority 1: Check auth_token cookie
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce(
      (acc, cookie) => {
        const [name, ...rest] = cookie.split('=');
        if (name && rest.length > 0) {
          acc[name.trim()] = rest.join('=').trim();
        }
        return acc;
      },
      {} as Record<string, string>
    );

    if (cookies['auth_token']) {
      return cookies['auth_token'];
    }
  }

  // Priority 2: Check Authorization header (backward compatibility)
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const [authType, token] = authHeader.split(' ');
    if (authType === 'Bearer' && token) {
      return token;
    }
  }

  return null;
}

/**
 * Get user identifier from request
 *
 * This function resolves the user identifier by:
 * 1. Attempting to verify authentication token and extract username
 * 2. Falling back to device identifier for guest users
 * 3. Generating a new device identifier if none exists
 *
 * @param request - The incoming HTTP request
 * @param api - NavigationAPI instance for token verification
 * @returns Promise resolving to user identifier and guest status
 *
 * @example
 * // Authenticated user
 * const { userId, isGuest } = await getUserIdentifier(request, api);
 * // userId: "admin", isGuest: false
 *
 * @example
 * // Guest user with existing device ID
 * const { userId, isGuest } = await getUserIdentifier(request, api);
 * // userId: "guest_abc123...", isGuest: true
 */
export async function getUserIdentifier(
  request: Request,
  api: NavigationAPI
): Promise<UserIdentifierResult> {
  // 1. Try to get authenticated user from token
  const token = getAuthToken(request);
  if (token) {
    try {
      const verifyResult = await api.verifyToken(token);
      if (verifyResult.valid && verifyResult.payload) {
        const username = verifyResult.payload.username;
        if (username && typeof username === 'string') {
          return {
            userId: username,
            isGuest: false,
          };
        }
      }
    } catch (error) {
      console.error('Token verification failed:', error);
      // Fall through to guest identifier
    }
  }

  // 2. Get or generate device identifier for guest users
  let deviceId = getDeviceIdentifier(request);
  if (!deviceId) {
    deviceId = generateDeviceIdentifier();
  }

  return {
    userId: deviceId,
    isGuest: true,
  };
}
