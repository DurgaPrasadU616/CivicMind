import { z } from 'zod';

// Zod validation schema for incoming complaints
export const createComplaintSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, { message: 'Complaint description cannot be empty.' })
    .max(5000, { message: 'Complaint description cannot exceed 5000 characters.' }),
  category: z.enum(['infrastructure', 'sanitation', 'utility', 'noise', 'safety', 'other'], {
    errorMap: () => ({ message: 'Please select a valid complaint category.' }),
  }),
  latitude: z
    .number()
    .min(-90, { message: 'Latitude must be between -90 and 90.' })
    .max(90, { message: 'Latitude must be between -90 and 90.' })
    .nullable()
    .optional(),
  longitude: z
    .number()
    .min(-180, { message: 'Longitude must be between -180 and 180.' })
    .max(180, { message: 'Longitude must be between -180 and 180.' })
    .nullable()
    .optional(),
  idempotencyKey: z
    .string()
    .uuid({ message: 'A valid idempotency key (UUIDv4) must be provided.' }),
  metaData: z.record(z.any()).optional().default({}),
});

export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;
