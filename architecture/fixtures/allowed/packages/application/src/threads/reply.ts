import type { ModelPort } from "../models/model-port.ts";
export const reply = (model: ModelPort): void => {
  model.stream();
};
