import type { ModuleMetadata } from "../types.js";
import { setModuleMetadata } from "../metadata.js";

export function Module(metadata: ModuleMetadata): ClassDecorator {
  return (target) => {
    setModuleMetadata(target, metadata);
  };
}
