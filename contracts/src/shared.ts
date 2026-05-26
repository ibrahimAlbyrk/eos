import { z } from "zod";

export const UnknownRecordSchema = z.record(z.string(), z.unknown());
