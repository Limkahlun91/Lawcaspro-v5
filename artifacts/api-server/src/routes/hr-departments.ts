import express, { type Request, type Response, type Router } from "express";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes";

const router: Router = express.Router();

router.delete("*", (_req: Request, res: Response) => {
  res.status(405).json(serializeHRError(createHRError(
    HR_ERROR_CODES.HR_METHOD_NOT_ALLOWED,
    "Departments cannot be hard deleted. Toggle is_active to false to archive instead.",
  )));
});

export default router;
