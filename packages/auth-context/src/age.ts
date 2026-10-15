import { ageOn } from "@qtiauth/common";
import type { AgeBand } from "./types.ts";

export interface AgeBoundaries {
  teen: number;
  older_teen: number;
  adult: number;
}

export function ageBand(dob: string | null | undefined, b: AgeBoundaries, on: Date = new Date()): AgeBand | null {
  if (!dob) return null;
  const age = ageOn(dob, on);
  if (age < b.teen) return "under_13";
  if (age < b.older_teen) return "13_to_15";
  if (age < b.adult) return "16_to_17";
  return "adult";
}

export function isMinor(band: AgeBand | null | undefined): boolean {
  return band !== "adult";
}
