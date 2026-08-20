import { Router } from "express";
import { handleLogin, handleLogout } from "../src/auth.js";

const router = Router();

router.get("/login", (req, res) => {
  res.render("login", { error: null });
});

router.post("/login", handleLogin);
router.post("/logout", handleLogout);

export default router;
