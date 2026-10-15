import type { PageRoute } from "./app.tsx";
import { authRoutes, sharedAuthRoutes } from "./pages/auth.tsx";
import { accountRoutes as settingsRoutes } from "./pages/account.tsx";
import { gateRoutes } from "./pages/gates.tsx";
import { oauthRoutes } from "./pages/oauth.tsx";
import { familyRoutes } from "./pages/family.tsx";
import { gameRoutes } from "./pages/games.tsx";
import { safetyRoutes } from "./pages/safety.tsx";
import { developerRoutes } from "./pages/developer.tsx";
import { adminRoutes } from "./pages/admin.tsx";
import { adminSafetyRoutes } from "./pages/admin-safety.tsx";
import { adminGamesRoutes } from "./pages/admin-games.tsx";
import { supportPublicRoutes } from "./pages/support.tsx";
import { staffRoutes } from "./pages/staff.tsx";

export const accountRoutes: PageRoute[] = [
  ...sharedAuthRoutes,
  ...authRoutes,
  ...gateRoutes,
  ...settingsRoutes,
  ...oauthRoutes,
  ...familyRoutes,
  ...gameRoutes,
  ...safetyRoutes,
  ...developerRoutes,
  ...adminRoutes,
  ...adminSafetyRoutes,
  ...adminGamesRoutes,
];

export const supportRoutes: PageRoute[] = [...sharedAuthRoutes, ...supportPublicRoutes, ...staffRoutes];

export const apiSurfaceRoutes: PageRoute[] = [];
