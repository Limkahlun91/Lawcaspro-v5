import * as zod from "zod";

export const RequestUploadUrlBody = zod.object({
  name: zod.string(),
  size: zod.number(),
  contentType: zod.string(),
});

export const RequestUploadUrlResponse = zod.object({
  uploadURL: zod.string(),
  objectPath: zod.string(),
});
