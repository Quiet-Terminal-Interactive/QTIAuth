import type { ServiceContext, Exec as KitExec } from "@qtiauth/service-kit";
import type { IdentityDB } from "../db/types.ts";

export type Ctx = ServiceContext<IdentityDB>;
export type Exec = KitExec<IdentityDB>;
