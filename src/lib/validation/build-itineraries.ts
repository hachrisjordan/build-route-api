import { z } from 'zod';

export const buildItinerariesSchema = z.object({
  origin: z.union([z.string().min(2), z.array(z.string().min(1))]),
  destination: z.union([z.string().min(2), z.array(z.string().min(1))]),
  maxStop: z.number().min(0).max(4),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  apiKey: z.string().min(8).nullable(),
  cabin: z.string().optional(),
  carriers: z.string().optional(),
  minReliabilityPercent: z.number().min(0).max(100).optional(),
  seats: z.coerce.number().int().min(1).default(1).optional(),
  united: z.coerce.boolean().default(false).optional(),
  binbin: z.coerce.boolean().default(false).optional(),
  region: z.coerce.boolean().default(false).optional(),
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

export type BuildItinerariesInput = z.infer<typeof buildItinerariesSchema>;


