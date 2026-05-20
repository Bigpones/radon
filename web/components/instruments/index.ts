/**
 * Instrument primitives — the production-facing barrel for the brand-true
 * components that previously lived only under /kit. Each primitive
 * embodies one cell of the brand's instrument grammar:
 *
 *   SignalSummary       — single-signal candidate readout (eyebrow +
 *                         metric + meta rail). Replaces ad-hoc
 *                         "big number + label" cards in MetricCards.
 *   PortfolioConvexity  — net-greek readout pattern; template for any
 *                         exposure/convexity summary surface.
 *   CircularScan        — radar/scanning empty-state motif. Use anywhere
 *                         a panel is currently rendering "no candidates"
 *                         text.
 *   EnergyDistribution  — spectral bar set. The static reference render
 *                         for the kit; SpectralLoader is its animated
 *                         loading-state derivative.
 *   SemanticStates      — badge palette (CLEAR / EMERGING / DISLOCATION /
 *                         QUALITY). Template for any tier or state pill.
 *   DenseNumericTable   — instrument-grade table primitive. Template for
 *                         replacing global <table> styling.
 *
 * MOVE 4 promotes these out of the /kit museum and into production. The
 * underlying files still live under components/kit/ — this barrel just
 * gives them a non-museum import path so production code never reaches
 * across the /kit boundary.
 */
export { SignalSummary } from "@/components/kit/SignalSummary";
export { PortfolioConvexity } from "@/components/kit/PortfolioConvexity";
export { CircularScan } from "@/components/kit/CircularScan";
export { EnergyDistribution } from "@/components/kit/EnergyDistribution";
export { SemanticStates } from "@/components/kit/SemanticStates";
export { DenseNumericTable } from "@/components/kit/DenseNumericTable";

// Markov engine grammar (docs/brand-identity.md § 7) — node graph + arcs.
export { MarkovStateGraph } from "@/components/instruments/MarkovStateGraph";
export type { MarkovStateGraphProps } from "@/components/instruments/MarkovStateGraph";

// Instrument-panel primitive — every hero / signal-summary card extends it.
export { InstrumentPanel } from "@/components/instruments/InstrumentPanel";
export type {
  InstrumentPanelProps,
  InstrumentPanelMetaRow,
  PanelTone,
} from "@/components/instruments/InstrumentPanel";

// Flow projection — SVG primary + optional overlay over projection geometry.
export { FlowProjectionTrace } from "@/components/instruments/FlowProjectionTrace";
export type {
  FlowProjectionSeries,
  FlowProjectionTraceProps,
} from "@/components/instruments/FlowProjectionTrace";

// Spectral bars — static-value bar set in spectral decomposition grammar.
export { SpectralBars } from "@/components/instruments/SpectralBars";
export type { SpectralBar, SpectralBarsProps } from "@/components/instruments/SpectralBars";

// Already brand-true production primitives.
export { default as SpectralLoader } from "@/components/SpectralLoader";
export { default as FooterTelemetryStrip } from "@/components/FooterTelemetryStrip";
