import { Router } from "express";
import { handleLogin, handleLogout } from "../src/auth.js";

export function createAuthRouter(lockStore) {
  const router = Router();

  router.get("/login", (req, res) => {
    res.render("login", { error: null });
  });

  router.post("/login", handleLogin);
  router.post("/logout", (req, res) => handleLogout(req, res, { lockStore }));

  return router;
}
