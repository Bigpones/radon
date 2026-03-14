"use client";

import Modal from "./Modal";

type Props = {
  open: boolean;
  title: string;
  value: string;
  definition: string;
  formula: string;
  onClose: () => void;
};

export default function MetricDefinitionModal({ open, title, value, definition, formula, onClose }: Props) {
  if (!open) return null;

  return (
    <Modal open onClose={onClose} title={title} className="mm30">
      <div className="et">
        <span className="etv neutral">{value}</span>
      </div>
      <div className="mdc">
        <span className="mdl">What It Is</span>
        <p>{definition}</p>
      </div>
      <div className="mdc">
        <span className="mdl">How It Is Calculated</span>
      </div>
      <div className="ef">
        <code>{formula}</code>
      </div>
    </Modal>
  );
}
