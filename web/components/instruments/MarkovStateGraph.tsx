"use client";

import type { ReactElement } from "react";

/**
 * MarkovStateGraph — node-graph primitive for regime transition lattices.
 *
 * Brand grammar (docs/brand-identity.md § 7): "Regime transitions, state
 * probabilities — Node graph, transition arcs, state lattice — Show
 * prior to current to likely next state".
 *
 * Pure SVG. No D3. No React Flow. Brand tokens only.
 */

interface MarkovState {
  id: string;
  label: string;
  current?: boolean;
}

interface MarkovTransition {
  from: string;
  to: string;
  probability: number;
}

export interface MarkovStateGraphProps {
  states: MarkovState[];
  transitions: MarkovTransition[];
  width?: number;
  height?: number;
  caption?: string;
  layout?: "linear" | "circular";
  pulse?: boolean;
}

const NODE_RADIUS = 11;
const NODE_BORDER = 1.5;
const CURRENT_RING = 2;
const CURRENT_GLOW = 4;
const SELF_LOOP_RADIUS = 15;
const SELF_LOOP_LIFT = 18;
const ARC_LIFT = 60;
const ARROWHEAD_LENGTH = 7;
const ARROWHEAD_WIDTH = 5;
const LABEL_OFFSET_Y = 28;
const PROB_LABEL_NUDGE = 6;
const PROB_LABEL_SELF_LOOP_NUDGE = 4;
const AXIS_PADDING_X = 48;
const HAIRLINE_ANGLE_DEG = 35;
const HAIRLINE_SPACING = 32;
const HAIRLINE_OPACITY = 0.3;

const COLOR_CURRENT = "var(--signal-core)";
const COLOR_INACTIVE_ARC = "var(--text-muted)";
const COLOR_NODE_BORDER = "var(--line-grid)";
const COLOR_NODE_FILL = "var(--bg-panel)";
const COLOR_LABEL_DIM = "var(--text-secondary)";
const COLOR_PROB_DIM = "var(--text-muted)";
const COLOR_HAIRLINE = "var(--line-grid)";
const CURRENT_GLOW_FILL = "color-mix(in srgb, var(--signal-core) 40%, transparent)";

interface Point {
  x: number;
  y: number;
}

function computeLinearPositions(
  states: MarkovState[],
  width: number,
  height: number,
): Record<string, Point> {
  const axisY = Math.round(height * 0.62);
  const usableWidth = Math.max(1, width - AXIS_PADDING_X * 2);
  const step = states.length > 1 ? usableWidth / (states.length - 1) : 0;
  const positions: Record<string, Point> = {};
  states.forEach((state, index) => {
    positions[state.id] = {
      x: AXIS_PADDING_X + step * index,
      y: axisY,
    };
  });
  return positions;
}

function isOutgoingFromCurrent(
  transition: MarkovTransition,
  states: MarkovState[],
): boolean {
  if (transition.from === transition.to) return false;
  const source = states.find((s) => s.id === transition.from);
  return Boolean(source?.current);
}

function strokeWidthForProbability(probability: number): number {
  const clamped = Math.max(0, Math.min(1, probability));
  return 0.5 + clamped * 3;
}

function percentLabel(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

function buildBezierPath(start: Point, end: Point): string {
  const midX = (start.x + end.x) / 2;
  const direction = end.x >= start.x ? -1 : 1;
  const controlY = start.y + direction * ARC_LIFT;
  return `M ${start.x} ${start.y} Q ${midX} ${controlY} ${end.x} ${end.y}`;
}

function bezierMidpoint(start: Point, end: Point): Point {
  const midX = (start.x + end.x) / 2;
  const direction = end.x >= start.x ? -1 : 1;
  const controlY = start.y + direction * ARC_LIFT;
  return {
    x: (start.x + 2 * midX + end.x) / 4,
    y: (start.y + 2 * controlY + end.y) / 4,
  };
}

function pointOnCircleBoundary(center: Point, towards: Point): Point {
  const dx = towards.x - center.x;
  const dy = towards.y - center.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return center;
  return {
    x: center.x + (dx / length) * NODE_RADIUS,
    y: center.y + (dy / length) * NODE_RADIUS,
  };
}

function controlPointForArc(start: Point, end: Point): Point {
  const midX = (start.x + end.x) / 2;
  const direction = end.x >= start.x ? -1 : 1;
  return { x: midX, y: start.y + direction * ARC_LIFT };
}

function arrowheadPolygon(tip: Point, towards: Point, length: number, width: number): string {
  const dx = tip.x - towards.x;
  const dy = tip.y - towards.y;
  const angle = Math.atan2(dy, dx);
  const baseX = tip.x - Math.cos(angle) * length;
  const baseY = tip.y - Math.sin(angle) * length;
  const perpX = -Math.sin(angle);
  const perpY = Math.cos(angle);
  const leftX = baseX + perpX * (width / 2);
  const leftY = baseY + perpY * (width / 2);
  const rightX = baseX - perpX * (width / 2);
  const rightY = baseY - perpY * (width / 2);
  return `${tip.x},${tip.y} ${leftX},${leftY} ${rightX},${rightY}`;
}

function renderHairlines(width: number, height: number): ReactElement[] {
  const radians = (HAIRLINE_ANGLE_DEG * Math.PI) / 180;
  const span = Math.max(width, height) * 2;
  const lines: ReactElement[] = [];
  for (let offset = -span; offset <= span; offset += HAIRLINE_SPACING) {
    const x1 = offset;
    const y1 = 0;
    const x2 = offset + Math.cos(radians) * span;
    const y2 = Math.sin(radians) * span;
    lines.push(
      <line
        key={`hairline-${offset}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={COLOR_HAIRLINE}
        strokeWidth={1}
        opacity={HAIRLINE_OPACITY}
      />,
    );
  }
  return lines;
}

interface ArcRenderInput {
  transition: MarkovTransition;
  positions: Record<string, Point>;
  isFromCurrent: boolean;
}

function renderSelfLoop({ transition, positions, isFromCurrent }: ArcRenderInput): ReactElement {
  const center = positions[transition.from];
  const loopCenter: Point = { x: center.x, y: center.y - NODE_RADIUS - SELF_LOOP_LIFT };
  const entry: Point = { x: center.x - SELF_LOOP_RADIUS / 2, y: center.y - NODE_RADIUS };
  const exit: Point = { x: center.x + SELF_LOOP_RADIUS / 2, y: center.y - NODE_RADIUS };
  const color = isFromCurrent ? COLOR_CURRENT : COLOR_INACTIVE_ARC;
  const probColor = isFromCurrent ? COLOR_CURRENT : COLOR_PROB_DIM;
  const arrowTip = exit;
  const arrowFrom: Point = { x: loopCenter.x + SELF_LOOP_RADIUS * 0.3, y: loopCenter.y };
  const path = `M ${entry.x} ${entry.y} C ${entry.x - SELF_LOOP_RADIUS * 0.6} ${loopCenter.y - SELF_LOOP_RADIUS * 0.6}, ${exit.x + SELF_LOOP_RADIUS * 0.6} ${loopCenter.y - SELF_LOOP_RADIUS * 0.6}, ${exit.x} ${exit.y}`;
  const labelY = loopCenter.y - SELF_LOOP_RADIUS - PROB_LABEL_SELF_LOOP_NUDGE;
  return (
    <g key={`arc-${transition.from}-${transition.to}-self`}>
      <path
        d={path}
        data-markov-arc="true"
        data-from={transition.from}
        data-to={transition.to}
        data-self-loop="true"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidthForProbability(transition.probability)}
      />
      <polygon
        points={arrowheadPolygon(arrowTip, arrowFrom, ARROWHEAD_LENGTH, ARROWHEAD_WIDTH)}
        fill={color}
      />
      <text
        data-markov-prob="true"
        x={loopCenter.x}
        y={labelY}
        textAnchor="middle"
        fontFamily="var(--font-mono)"
        fontSize={10}
        fill={probColor}
      >
        {percentLabel(transition.probability)}
      </text>
    </g>
  );
}

function renderBezierArc({ transition, positions, isFromCurrent }: ArcRenderInput): ReactElement {
  const sourceCenter = positions[transition.from];
  const targetCenter = positions[transition.to];
  const control = controlPointForArc(sourceCenter, targetCenter);
  const start = pointOnCircleBoundary(sourceCenter, control);
  const end = pointOnCircleBoundary(targetCenter, control);
  const color = isFromCurrent ? COLOR_CURRENT : COLOR_INACTIVE_ARC;
  const probColor = isFromCurrent ? COLOR_CURRENT : COLOR_PROB_DIM;
  const midpoint = bezierMidpoint(start, end);
  return (
    <g key={`arc-${transition.from}-${transition.to}`}>
      <path
        d={buildBezierPath(start, end)}
        data-markov-arc="true"
        data-from={transition.from}
        data-to={transition.to}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidthForProbability(transition.probability)}
      />
      <polygon
        points={arrowheadPolygon(end, control, ARROWHEAD_LENGTH, ARROWHEAD_WIDTH)}
        fill={color}
      />
      <text
        data-markov-prob="true"
        x={midpoint.x}
        y={midpoint.y - PROB_LABEL_NUDGE}
        textAnchor="middle"
        fontFamily="var(--font-mono)"
        fontSize={10}
        fill={probColor}
      >
        {percentLabel(transition.probability)}
      </text>
    </g>
  );
}

function renderTransition(input: ArcRenderInput): ReactElement {
  if (input.transition.from === input.transition.to) {
    return renderSelfLoop(input);
  }
  return renderBezierArc(input);
}

function renderNode(state: MarkovState, position: Point, pulse: boolean): ReactElement {
  const isCurrent = Boolean(state.current);
  const stroke = isCurrent ? COLOR_CURRENT : COLOR_NODE_BORDER;
  const strokeWidth = isCurrent ? CURRENT_RING : NODE_BORDER;
  const labelColor = isCurrent ? COLOR_CURRENT : COLOR_LABEL_DIM;
  const pulseClass = isCurrent && pulse ? "markov-current-pulse" : undefined;
  return (
    <g key={`node-${state.id}`}>
      {isCurrent && (
        <circle
          cx={position.x}
          cy={position.y}
          r={NODE_RADIUS + CURRENT_GLOW}
          fill={CURRENT_GLOW_FILL}
          stroke="none"
        />
      )}
      <circle
        data-markov-node="true"
        data-id={state.id}
        data-current={isCurrent ? "true" : "false"}
        cx={position.x}
        cy={position.y}
        r={NODE_RADIUS}
        fill={COLOR_NODE_FILL}
        stroke={stroke}
        strokeWidth={strokeWidth}
        className={pulseClass}
      />
      <text
        data-markov-label="true"
        x={position.x}
        y={position.y + LABEL_OFFSET_Y}
        textAnchor="middle"
        fontFamily="var(--font-mono)"
        fontSize={11}
        fill={labelColor}
      >
        {state.label}
      </text>
    </g>
  );
}

export function MarkovStateGraph({
  states,
  transitions,
  width = 480,
  height = 280,
  caption,
  layout = "linear",
  pulse = false,
}: MarkovStateGraphProps) {
  void layout; // linear is the only supported layout for now
  const positions = computeLinearPositions(states, width, height);
  return (
    <div style={{ width: "100%" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Markov state transition graph"
        style={{ display: "block" }}
      >
        <g data-markov-hairlines="true">{renderHairlines(width, height)}</g>
        <g data-markov-arcs="true">
          {transitions.map((transition) =>
            renderTransition({
              transition,
              positions,
              isFromCurrent: isOutgoingFromCurrent(transition, states),
            }),
          )}
        </g>
        <g data-markov-nodes="true">
          {states.map((state) => renderNode(state, positions[state.id], pulse))}
        </g>
      </svg>
      {caption && (
        <p
          data-markov-caption="true"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            marginTop: 12,
            textAlign: "center",
          }}
        >
          {caption}
        </p>
      )}
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .markov-current-pulse {
            animation: markov-pulse 2.4s ease-in-out infinite;
            transform-box: fill-box;
            transform-origin: center;
          }
        }
        @keyframes markov-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.75; }
        }
      `}</style>
    </div>
  );
}
