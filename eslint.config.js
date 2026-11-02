import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**", "auto-imports.d.ts", "components.d.ts"] },
  js.configs.recommended,
  ...vue.configs["flat/essential"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...Object.fromEntries(
          [
            "defineProps",
            "defineEmits",
            "defineExpose",
            "withDefaults",
            "h",
            "ref",
            "reactive",
            "computed",
            "watch",
            "provide",
            "inject",
            "defineComponent",
            "onBeforeMount",
            "onMounted",
            "onBeforeUnmount",
            "onUnmounted",
            "nextTick",
            "ElMessage",
            "$openList",
          ].map((name) => [name, "readonly"]),
        ),
      },
    },
    rules: { "vue/multi-word-component-names": "off" },
  },
];
