import { z } from 'zod';

export const createFullRoutePathSchema = z.object({
  origin: z.string().length(3).regex(/^[A-Z]{3}$/),
  destination: z.string().length(3).regex(/^[A-Z]{3}$/),
  maxStop: z.number().int().min(0).max(4).default(4),
});

export type CreateFullRoutePathInput = z.infer<typeof createFullRoutePathSchema>; 