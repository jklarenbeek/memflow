/**
 * LoadingSkeleton — Reusable shimmer skeleton for loading states
 */

interface Props {
  variant?: "line" | "circle" | "card";
  width?: string;
  height?: string;
  count?: number;
}

export function LoadingSkeleton({ variant = "line", width, height, count = 1 }: Props) {
  const items = Array.from({ length: count }, (_, i) => i);

  return (
    <div className="skeleton-container">
      {items.map((i) => (
        <div
          key={i}
          className={`skeleton skeleton-${variant}`}
          style={{
            width: width ?? (variant === "circle" ? "2rem" : "100%"),
            height: height ?? (variant === "circle" ? "2rem" : variant === "card" ? "4rem" : "0.75rem"),
          }}
        />
      ))}
    </div>
  );
}
