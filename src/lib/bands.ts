export const BANDS = ["A1", "A2", "B1", "B2", "C1"] as const
export type Band = (typeof BANDS)[number]

/**
 * Fixed, published before the first eval run. Derived from the speaker-level
 * 5-expert mean accuracy distribution across all 250 corpus speakers.
 * These are pronunciation-derived proxies, NOT CEFR assessments.
 */
export const BAND_TABLE: { band: Band; min: number; max: number }[] = [
  { band: "A1", min: -Infinity, max: 5.5 },
  { band: "A2", min: 5.5, max: 7.0 },
  { band: "B1", min: 7.0, max: 8.0 },
  { band: "B2", min: 8.0, max: 8.6 },
  { band: "C1", min: 8.6, max: Infinity },
]

export function bandForAccuracy(meanExpertAccuracy: number): Band {
  // Upper bound exclusive except B2, whose 8.6 boundary is inclusive per the table.
  for (const row of BAND_TABLE) {
    if (row.band === "B2" ? meanExpertAccuracy <= row.max : meanExpertAccuracy < row.max) {
      if (meanExpertAccuracy >= row.min) return row.band
    }
  }
  return "C1"
}

export function bandDistance(a: Band, b: Band): number {
  return Math.abs(BANDS.indexOf(a) - BANDS.indexOf(b))
}
