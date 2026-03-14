"use client";

import type { OpenOrder } from "@/lib/types";
import Modal from "./Modal";
import { fmtPrice } from "@/lib/positionUtils";

type CancelOrderDialogProps = {
  order: OpenOrder | null;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export default function CancelOrderDialog({ order, loading, onConfirm, onClose }: CancelOrderDialogProps) {
  if (!order) return null;

  const partiallyFilled = order.filled > 0 && order.remaining > 0;

  return (
    <Modal open={!!order} onClose={onClose} title="Cancel Order">
      <div className="cd145">
        <div className="cd50">
          <div className="cd-r">
            <span className="cl">Symbol</span>
            <span className="cv"><strong>{order.symbol}</strong></span>
          </div>
          <div className="cd-r">
            <span className="cl">Action</span>
            <span className="cv">
              <span className={`pill ${order.action === "BUY" ? "accum" : "distrib"}`}>
                {order.action}
              </span>
            </span>
          </div>
          <div className="cd-r">
            <span className="cl">Type</span>
            <span className="cv">{order.orderType}</span>
          </div>
          <div className="cd-r">
            <span className="cl">Quantity</span>
            <span className="cv">{order.totalQuantity}</span>
          </div>
          {order.limitPrice != null && (
            <div className="cd-r">
              <span className="cl">Limit Price</span>
              <span className="cv">{fmtPrice(order.limitPrice)}</span>
            </div>
          )}
          <div className="cd-r">
            <span className="cl">Status</span>
            <span className="cv">{order.status}</span>
          </div>
        </div>

        {partiallyFilled && (
          <div className="cw126">
            Partially filled ({order.filled} of {order.totalQuantity}). Only the remaining {order.remaining} will be cancelled.
          </div>
        )}

        <div className="ca127">
          <button className="bt-s" onClick={onClose} disabled={loading}>
            Keep Order
          </button>
          <button className="btn-danger" onClick={onConfirm} disabled={loading}>
            {loading ? "Cancelling..." : "Cancel Order"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
