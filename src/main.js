import { createApp } from "vue";
import "@/style/style.scss";
import "@/style/global.scss";
import App from "@/App.vue";
// 引入 pinia
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
// swiper
import "swiper/css";
import "swiper/css/pagination";

const app = createApp(App);
const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

app.use(pinia);
app.mount("#app");

// PWA
const wasControlled = Boolean(navigator.serviceWorker?.controller);
let refreshing = false;
navigator.serviceWorker?.addEventListener("controllerchange", () => {
  if (!wasControlled || refreshing) return;
  refreshing = true;
  window.location.reload();
});
