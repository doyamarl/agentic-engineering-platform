import type { MissionDto } from "../../packages/contracts/mission.ts";
export const render = (m: MissionDto): string => m.id;
