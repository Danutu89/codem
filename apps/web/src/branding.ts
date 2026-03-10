export const APP_BASE_NAME = "Codem";
export const APP_STAGE_LABEL = import.meta.env.DEV ? "Dev" : "";
export const APP_DISPLAY_NAME = APP_STAGE_LABEL
  ? `${APP_BASE_NAME} (${APP_STAGE_LABEL})`
  : APP_BASE_NAME;
