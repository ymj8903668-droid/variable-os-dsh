// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only

// Adapt only the native settings dialog containing our mounted section. The
// semantic dialog/nav structure avoids coupling to the Host's CSS module hashes;
// :has() releases every override when a different native section is selected.
export const SERVICE_SETTINGS_LAYOUT_CSS = `
.vos-service-settings{padding:16px;max-width:792px;min-width:0}
@media(max-width:640px){
  [role="dialog"]:has(.vos-service-settings){flex-direction:column;max-width:calc(100vw - 24px)}
  [role="dialog"]:has(.vos-service-settings)>nav{width:auto;padding:16px 12px 0;gap:8px}
  [role="dialog"]:has(.vos-service-settings)>nav>div:last-child{flex-direction:row;flex-wrap:wrap;max-height:144px;overflow:auto}
  [role="dialog"]:has(.vos-service-settings)>nav button{flex:1 1 120px;min-width:0;min-height:40px}
  [role="dialog"]:has(.vos-service-settings)>div{min-height:0}
  [role="dialog"]:has(.vos-service-settings)>div>div:last-child{padding:0 12px 16px}
  .vos-service-settings{padding:8px}
  .vos-service-settings .vos-settings dl{grid-template-columns:minmax(0,1fr)}
}
`;
