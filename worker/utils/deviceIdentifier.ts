/**
 * Device Identifier Management Utilities
 *
 * Provides functions for generating, retrieving, and validating device identifiers
 * used to track guest user preferences.
 */

/**
 * Parse cookies from Cookie header string
 */
function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  cookieHeader.split(';').forEach((cookie) => {
    const [name, ...rest] = cookie.split('=');
    if (name && rest.length > 0) {
      cookies[name.trim()] = rest.join('=').trim();
    }
  });

  return cookies;
}

/**
 * Get device identifier from request headers or cookies
 *
 * Priority:
 * 1. X-Device-ID header (sent by frontend)
 * 2. device_id cookie
 *
 * @param request - The incoming HTTP request
 * @returns Device identifier string or null if not found
 */
export function getDeviceIdentifier(request: Request): string | null {
  // Priority 1: Check X-Device-ID header
  const headerDeviceId = request.headers.get('X-Device-ID');
  if (headerDeviceId) {
    return headerDeviceId;
  }

  // Priority 2: Check device_id cookie
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    return cookies['device_id'] || null;
  }

  return null;
}

/**
 * Generate a new unique device identifier
 *
 * Uses crypto.randomUUID() to ensure uniqueness and unpredictability.
 * Format: guest_<uuid>
 *
 * @returns A new device identifier string
 */
export function generateDeviceIdentifier(): string {
  return `guest_${crypto.randomUUID()}`;
}

/**
 * Validate device identifier format
 *
 * Valid format: guest_<uuid>
 * Where <uuid> is a standard UUID v4 format:
 * xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *
 * @param id - The device identifier to validate
 * @returns true if valid, false otherwise
 */
export function isValidDeviceIdentifier(id: string): boolean {
  if (!id || typeof id !== 'string') {
    return false;
  }

  // UUID v4 format: 8-4-4-4-12 hexadecimal characters
  const uuidPattern = /^guest_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(id);
}
