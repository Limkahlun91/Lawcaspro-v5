import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import platformRouter from "./platform";
import usersRouter from "./users";
import rolesRouter from "./roles";
import developersRouter from "./developers";
import projectsRouter from "./projects";
import clientsRouter from "./clients";
import casesRouter from "./cases";
import dashboardRouter from "./dashboard";
import storageRouter from "./storage";
import documentsRouter from "./documents";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(platformRouter);
router.use(usersRouter);
router.use(rolesRouter);
router.use(developersRouter);
router.use(projectsRouter);
router.use(clientsRouter);
router.use(casesRouter);
router.use(dashboardRouter);
router.use(storageRouter);
router.use(documentsRouter);

export default router;
