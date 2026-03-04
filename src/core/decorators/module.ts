import type { ModuleMetadata } from "../types";
import { setModuleMetadata } from "../metadata";

export function Module(metadata: ModuleMetadata): ClassDecorator {
  return (target) => {
    setModuleMetadata(target, metadata);
  };
}
