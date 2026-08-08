import express, { type Request, type Response, type Router } from "express";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes";

const router: Router = express.Router();

router.delete("*", (_req: Request, res: Response) => {
  res.status(405).json(serializeHRError(createHRError(
    HR_ERROR_CODES.HR_METHOD_NOT_ALLOWED,
    "HR documents cannot be hard deleted. Change document visibility or archive status instead.",
  )));
});

export default router;
