"use client";

import MetricBreakdownModal from "./MetricBreakdownModal";

type Props = {
  open: boolean;
  title: string;
  value: string;
  formula: string;
  onClose: () => void;
};

export default function AccountMetricModal({ open, title, value, formula, onClose }: Props) {
  return (
    <MetricBreakdownModal
      open={open}
      onClose={onClose}
      title={title}
      className="account-metric-modal"
      value={value}
      valueTone="neutral"
      formula={formula}
    />
  );
}
