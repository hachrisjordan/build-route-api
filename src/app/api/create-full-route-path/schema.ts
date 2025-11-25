import { z } from 'zod';

export const createFullRoutePathSchema = z.object({
  origin: z.union([
    z.string().regex(/^([A-Z]{3})(\/[A-Z]{3})*$/),
    z.array(z.string().min(1))
  ]),
  destination: z.union([
    z.string().regex(/^([A-Z]{3})(\/[A-Z]{3})*$/),
    z.array(z.string().min(1))
  ]),
  maxStop: z.number().int().min(0).max(4).default(4),
  region: z.boolean().optional(),
  binbin: z.boolean().optional(),
}).refine((data) => {
  // When region=true, origin and destination must be arrays
  if (data.region === true) {
    if (!Array.isArray(data.origin) || !Array.isArray(data.destination)) {
      return false;
    }
    // When region=true, maxStop must be between 0-2
    if (data.maxStop > 2) {
      return false;
    }
  }
  return true;
}, {
  message: "When region=true, origin and destination must be arrays and maxStop must be between 0-2",
  path: ["region"]
});

export type CreateFullRoutePathInput = z.infer<typeof createFullRoutePathSchema>; 