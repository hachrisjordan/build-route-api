import { z } from 'zod';

export const availabilityV2Schema = z.object({
  routeId: z.string().min(3),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  cabin: z.string().optional(),
  carriers: z.string().optional(),
  seats: z.coerce.number().int().min(1).default(1).optional(),
  united: z.coerce.boolean().default(false).optional(),
  binbin: z.coerce.boolean().default(false).optional(),
  maxStop: z.coerce.number().int().min(0).max(4).optional(),
});

export type AvailabilityV2Input = z.infer<typeof availabilityV2Schema>;


