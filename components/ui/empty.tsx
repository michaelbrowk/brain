import { Icon, type SolarIconName } from "./icon";

export function Empty({
  icon,
  title,
  hint,
  className,
}: {
  icon: SolarIconName;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={[
        "flex flex-col items-center justify-center gap-1.5 text-center",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Icon name={icon} size={20} className="text-ink-3" />
      <p className="text-[13px] text-ink-2">{title}</p>
      {hint && <p className="max-w-[28ch] text-[12px] leading-snug text-ink-3">{hint}</p>}
    </div>
  );
}
