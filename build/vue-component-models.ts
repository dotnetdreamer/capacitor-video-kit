import type { BuildCtx, CompilerCtx, Config, OutputTargetCustom } from '@stencil/core/internal';
import type { ComponentModelConfig } from '@stencil/vue-output-target';

/**
 * Fails the build when a component could be bound with `v-model` but has not been told how.
 *
 * `v-model` on a generated Vue wrapper is opt in per component: the Vue output target only wires it
 * up for the tags listed in its `componentModels`, and it says nothing about the ones that are not.
 * There is no error and no warning, because the generated type is
 * `StencilVueComponent<Props, string | number | boolean>` either way, and that type carries a
 * `modelValue` prop whether the component was configured or not. So `<VeSlider v-model="volume" />`
 * type checks, renders, and silently never writes back. That is the worst failure a binding can
 * have, and it is what this exists to convert into a build error.
 *
 * The rule it enforces is mechanical rather than a judgement: a component is two way bindable when
 * it declares a prop `x` and an event `xChange`. That is the same pair Angular's `[(x)]` requires,
 * so it is already the convention the editor's controls are written to, and it is exactly the shape
 * `componentModels` exists to describe.
 */
export function requireVueComponentModels(componentModels: ComponentModelConfig[]): OutputTargetCustom {
  return {
    type: 'custom',
    name: 'vue-component-models',
    async generator(_config: Config, _compilerCtx: CompilerCtx, buildCtx: BuildCtx): Promise<void> {
      const missing: string[] = [];

      for (const cmp of buildCtx.components) {
        const events = new Set(cmp.events.map((event) => event.name));
        for (const prop of cmp.properties) {
          const changeEvent = `${prop.name}Change`;
          if (!events.has(changeEvent)) continue;
          if (isModelled(componentModels, cmp.tagName, prop.name)) continue;
          missing.push(
            `  ${cmp.tagName} binds ${prop.name} and emits ${changeEvent}, so add\n` +
              `    { elements: '${cmp.tagName}', event: '${changeEvent}', targetAttr: '${prop.name}' }\n` +
              `  to componentModels in stencil.config.ts, or v-model on it will do nothing.`,
          );
        }
      }

      if (missing.length > 0) {
        throw new Error(`v-model is unconfigured for ${missing.length} binding(s):\n${missing.join('\n')}`);
      }
    },
  };
}

function isModelled(componentModels: ComponentModelConfig[], tagName: string, propName: string): boolean {
  return componentModels.some((model) => {
    const elements = Array.isArray(model.elements) ? model.elements : [model.elements];
    return elements.includes(tagName) && model.targetAttr === propName;
  });
}
