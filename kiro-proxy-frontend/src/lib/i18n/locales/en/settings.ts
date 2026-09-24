import { type settings as zhSettings } from '../zh/settings'

export const settings: typeof zhSettings = {
  drawer: {
    trigger: 'Open theme settings',
    title: 'Theme Settings',
    desc: 'Adjust the appearance and layout to suit your preferences.',
    resetAll: 'Reset',
    resetAllAria: 'Reset all settings to default values',
  },
  theme: {
    label: 'Theme',
    toggle: 'Toggle theme',
    resetAria: 'Reset theme preference to default',
    selectAria: 'Select theme preference',
    describedBy: 'Choose between system preference, light mode, or dark mode',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
  },
  sidebar: {
    label: 'Sidebar',
    resetAria: 'Reset sidebar style to default',
    selectAria: 'Select sidebar style',
    describedBy: 'Choose between inset, floating, or standard sidebar layout',
    inset: 'Inset',
    floating: 'Floating',
    sidebar: 'Sidebar',
  },
  layout: {
    label: 'Layout',
    resetAria: 'Reset layout options to default',
    selectAria: 'Select layout style',
    describedBy:
      'Choose between default expanded, compact icon-only, or full layout mode',
    default: 'Default',
    compact: 'Compact',
    full: 'Full layout',
  },
  direction: {
    label: 'Direction',
    resetAria: 'Reset text direction to default',
    selectAria: 'Select site direction',
    describedBy: 'Choose between left-to-right or right-to-left site direction',
    ltr: 'Left to Right',
    rtl: 'Right to Left',
  },
  language: {
    label: 'Language',
    toggle: 'Toggle language',
    selectAria: 'Select interface language',
  },
  radio: {
    selectAria: 'Select {label}',
    previewAria: '{label} option preview',
  },
}
