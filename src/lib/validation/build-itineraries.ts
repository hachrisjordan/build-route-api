import { z } from 'zod';

export const buildItinerariesSchema = z.object({
  origin: z.string().min(2),
  destination: z.string().min(2),
  maxStop: z.number().min(0).max(4),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  apiKey: z.string().min(8).nullable(),
  cabin: z.string().optional(),
  carriers: z.string().optional(),
  minReliabilityPercent: z.number().min(0).max(100).optional(),
  seats: z.coerce.number().int().min(1).default(1).optional(),
  united: z.coerce.boolean().default(false).optional(),
});

export type BuildItinerariesInput = z.infer<typeof buildItinerariesSchema>;


