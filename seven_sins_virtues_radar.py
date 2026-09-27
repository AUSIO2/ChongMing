"""Draw a 14-axis radar chart from the visible conversation evidence."""

from pathlib import Path
import os
import tempfile

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "seven_sins_virtues_mpl"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
import numpy as np


# Five means that the available conversation does not support a directional judgment.
# Each item was scored separately; paired items are not constrained to sum to ten.
LABELS = [
    "傲慢", "贪婪", "色欲", "嫉妒", "暴食", "愤怒", "懒惰",
    "勤奋", "耐心", "节制", "仁慈", "贞洁", "慷慨", "谦逊",
]
SCORES = [5, 5, 5, 5, 5, 5, 5, 6, 5, 5, 5, 5, 5, 6]


def main() -> None:
    font = FontProperties(fname=r"C:\Windows\Fonts\msyh.ttc")
    font_bold = FontProperties(fname=r"C:\Windows\Fonts\msyhbd.ttc")
    n = len(LABELS)
    theta = (np.arange(n) + 0.5) * (2 * np.pi / n)

    fig, ax = plt.subplots(figsize=(10, 9), subplot_kw={"projection": "polar"})
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    fig.subplots_adjust(left=0.16, right=0.84, bottom=0.13, top=0.87)

    ax.set_theta_zero_location("N")
    ax.set_theta_direction(1)
    ax.set_ylim(0, 10)
    ax.set_xticks(theta)
    ax.set_xticklabels([])
    ax.set_yticks([2, 4, 6, 8, 10])
    ax.set_yticklabels(["2", "4", "6", "8", "10"], color="#67717C", fontsize=10)
    ax.set_rlabel_position(180)
    ax.tick_params(axis="y", pad=4)
    ax.grid(color="#DCE1E5", linewidth=0.8)
    ax.spines["polar"].set_color("#BBC4CB")
    ax.spines["polar"].set_linewidth(0.8)

    closed_theta = np.r_[theta, theta[0]]
    closed_scores = np.r_[SCORES, SCORES[0]]
    ax.fill(closed_theta, closed_scores, color="#C5D0D4", alpha=0.28, zorder=2)
    ax.plot(closed_theta, closed_scores, color="#5B6872", linewidth=1.5, zorder=3)
    ax.scatter(theta[:7], SCORES[:7], s=42, color="#A75B52", zorder=4)
    ax.scatter(theta[7:], SCORES[7:], s=42, color="#397A75", zorder=4)

    for i, (angle, label, score) in enumerate(zip(theta, LABELS, SCORES)):
        color = "#944E46" if i < 7 else "#2B6A65"
        ax.text(
            angle, 11.72, f"{label}\n{score}",
            ha="center", va="center", color=color, fontsize=12,
            fontproperties=font_bold if score != 5 else font,
            linespacing=1.35, clip_on=False,
        )

    output = ROOT / "seven_sins_virtues_radar.png"
    fig.savefig(output, dpi=220, facecolor="white")
    fig.savefig(ROOT / "seven_sins_virtues_radar.svg", facecolor="white")
    plt.close(fig)
    print(output)


if __name__ == "__main__":
    main()
