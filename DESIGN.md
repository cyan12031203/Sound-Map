---
version: alpha
colors:
  primary: "#173D24"
  text-primary: "#132617"
  text-secondary: "rgba(19, 38, 23, 0.62)"
  glass-light: "rgba(249, 250, 242, 0.44)"
  glass-medium: "rgba(245, 248, 239, 0.56)"
typography:
  ui:
    fontFamily: "Inter, SF Pro Display, SF Pro Text, PingFang SC, Noto Sans SC, system-ui, sans-serif"
rounded:
  field: "26px"
  panel: "30px"
  screen: "34px"
  pill: "999px"
spacing:
  page: "30px"
  field-gap: "20px"
  desktop-gap: "30px"
components:
  glass:
    backgroundColor: "{colors.glass-light}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.panel}"
  intro-card:
    backgroundColor: "{colors.glass-medium}"
    textColor: "{colors.text-primary}"
    typography: "{typography.ui}"
    rounded: "{rounded.panel}"
  secondary-copy:
    textColor: "{colors.text-secondary}"
    typography: "{typography.ui}"
  primary-action:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    height: "64px"
    rounded: "32px"
---

## Overview

Sound-Map is a mobile-first route-to-music product for people using it immediately before or during a journey. Its North Star is a quiet cinematic view through moving greenery: route information and music controls float over blurred natural light without becoming a navigation dashboard or a conventional streaming player.

The product register is editorial product UI. Its signature is the slow, freely drifting green landscape visible through every frosted surface. Restraint wins everywhere else: no decorative copy, no opaque cards, no pure black, no dense navigation, and no additional metadata beyond the approved three-screen specification.

## Colors

Runtime CSS custom properties in `public/styles.css` are canonical. This file mirrors their accepted semantic values. Dark forest green replaces black; translucent warm-white surfaces preserve the lime, yellow, forest green, and pale blue-gray of the supplied landscape.

## Typography

Use the locale-capable sans stack above. English chrome such as `SOUNDTRACK`, `Sound-Map`, and `NOW PLAYING` remains verbatim and lightly tracked. Chinese introduction copy uses generous line height and medium weight. Decorative serif type is prohibited.

## Layout

The canonical canvas is 430×932. Screen 1 intentionally reserves a large blank interval between its header and route fields. Screen 2 keeps one 370×460 introduction panel surrounded by open background. Screen 3 follows the supplied vertical player anatomy. Desktop review shows all three screens side by side; mobile shows one state at a time. On phones, each screen reflows to the available width, observes safe-area insets, and allows vertical scrolling when short viewports, long text, or the virtual keyboard reduce the available space; route submission and player controls remain reachable.

Screen 2 transitions to Screen 3 through an understated upward-swipe cue. Touch users can swipe upward anywhere on the introduction screen; the cue remains a semantic button for pointer and keyboard access. Pagination dots are not used on this transition.
Entering Screen 3 immediately starts the prepared song when browser playback policy permits; the visible play control remains the recovery path when autoplay is blocked. Overflowing introduction copy and lyrics use a single hairline frosted scrollbar without native arrow buttons.

## Elevation & Depth

Depth comes from background blur, a thin white inner edge, and very soft green shadow. Surfaces never become opaque white. The moving background remains the strongest continuous layer.

## Shapes

Route rows use 26px corners, large panels 30px, the desktop phone canvas 34px, and primary actions/progress tracks use pill geometry. Do not substitute generic framework radius presets.

## Components

Route fields share one four-column anatomy: English label, green icon, value/control, chevron. The primary action keeps fixed geometry while busy. The introduction card contains only the quote mark and generated introduction. Song progress uses an interactive waveform-backed range control; route progress uses one knob-free bar. Playback controls operate the generated网易云 playlist through the local backend. The lyric surface scrolls the active timestamped line into view and keeps translated text secondary.

## Do's and Don'ts

- Do preserve the English product words exactly.
- Do keep the background moving slowly and freeze it for reduced-motion users.
- Do use native semantic form controls and visible focus.
- Do keep failures inline on Screen 1 and preserve entered values.
- Don't display Agent stage summaries, raw reasoning, loading copy on Screen 2, ETA, remaining route minutes, a volume control, or album artwork.
- Don't add “今天去哪里？” or any descriptive subtitle above the route form.
