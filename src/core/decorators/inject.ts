import type { Constructor } from "../types";
import { setInjectionToken } from "../metadata";

export function Inject(token: Constructor | string | symbol): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    const injectionTarget =
      typeof target === "function" ? target : (target.constructor as Function);

    setInjectionToken(injectionTarget, parameterIndex, token);
  };
}
