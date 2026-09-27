import { z } from 'zod';
export const deviceInfoSchema = z.object({
  deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']),
  os: z.enum(['iOS', 'Android', 'Windows', 'macOS', 'ChromeOS', 'Linux', 'unknown']),
  browser: z.enum(['Chrome', 'Safari', 'Edge', 'Firefox', 'Opera', 'Samsung Internet', 'unknown']),
}).strict();
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;
export const identitySchema = z.object({ identityId: z.string().uuid().optional(), deviceInfo: deviceInfoSchema.optional() });
