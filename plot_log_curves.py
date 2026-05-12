import numpy as np
import matplotlib.pyplot as plt

plt.rcParams.update({
    'font.family': 'serif',
    'font.size': 10,
    'axes.labelsize': 11,
    'axes.titlesize': 12,
    'legend.fontsize': 9,
    'grid.alpha': 0.25,
})


def logC3_raw(x):
    cut = 0.01
    mid = 0.18
    x = np.asarray(x, dtype=float)
    out = np.zeros_like(x)
    mask = x > cut
    out[~mask] = x[~mask] * (0.5 / cut)
    out[mask] = 0.5 + 0.5 * (np.log10(x[mask] / cut) / np.log10(mid / cut))
    return out.item() if out.ndim == 0 else out


def flog2_raw(x):
    a = 7.6406
    b = 5.0
    x = np.asarray(x, dtype=float)
    out = (np.log10(np.maximum(x, 1e-15)) + a) / b
    out = np.maximum(0, out)
    return out.item() if out.ndim == 0 else out


x = np.logspace(-4, 1.2, 2000)

vL = logC3_raw(x)
vF = flog2_raw(x)

fig, axes = plt.subplots(1, 3, figsize=(15, 4.8))

# --- Panel 1: raw curves (each on its own scale to fill [0, ~max]) ---
# Normalize each to its own [0, 1]
vL_n1 = vL / vL[-1]
vF_n1 = vF / vF[-1]

axes[0].plot(x, vL_n1, label='ARRI LogC3', color='#E3122E', lw=2)
axes[0].plot(x, vF_n1, label='Fujifilm F-Log2', color='#007BC0', lw=2)
axes[0].set_xscale('log')
axes[0].set_xlabel('Scene Linear Value')
axes[0].set_ylabel('Encoded Value (each curve normalized to [0,1])')
axes[0].set_title('Shape Comparison (self-normalized)')
axes[0].legend(loc='upper left')
axes[0].grid(True)
axes[0].axvline(0.18, color='gray', ls=':', lw=0.8)
axes[0].text(0.18, 0.02, '18% gray', fontsize=8, color='gray', ha='center',
             rotation=90)

# --- Panel 2: aligned at 18% gray = 0.5 ---
v18L = logC3_raw(0.18)
v18F = flog2_raw(0.18)

vL_n2 = vL / v18L * 0.5
vF_n2 = vF / v18F * 0.5

axes[1].plot(x, vL_n2, label='ARRI LogC3', color='#E3122E', lw=2)
axes[1].plot(x, vF_n2, label='Fujifilm F-Log2', color='#007BC0', lw=2)
axes[1].set_xscale('log')
axes[1].set_xlabel('Scene Linear Value')
axes[1].set_ylabel('Encoded Value (18% gray = 0.5)')
axes[1].set_title('Aligned at 18% Gray')
axes[1].legend(loc='upper left')
axes[1].grid(True)
axes[1].axvline(0.18, color='gray', ls=':', lw=0.8)
axes[1].text(0.18, 0.02, '18% gray', fontsize=8, color='gray', ha='center',
             rotation=90)

# --- Panel 3: slope (derivative) ---
# Use log-x derivative = dy / d(log10 x)  ~  x * dy/dx
dx = np.diff(x)
dL = np.diff(vL_n2) / np.log10(x[1:] / x[:-1])  # dV / d(log10 x)
dF = np.diff(vF_n2) / np.log10(x[1:] / x[:-1])
xc = np.sqrt(x[:-1] * x[1:])  # geometric mean for plotting

axes[2].plot(xc, dL, label='ARRI LogC3', color='#E3122E', lw=2)
axes[2].plot(xc, dF, label='Fujifilm F-Log2', color='#007BC0', lw=2)
axes[2].set_xscale('log')
axes[2].set_xlabel('Scene Linear Value')
axes[2].set_ylabel('Slope dV / d(log₁₀ L)')
axes[2].set_title('Slope (contrast distribution)')
axes[2].legend(loc='upper left')
axes[2].grid(True)
axes[2].axvline(0.18, color='gray', ls=':', lw=0.8)
axes[2].axhline(0, color='gray', ls=':', lw=0.5)

for ax in axes:
    ax.set_xlim(1e-4, 15)

plt.tight_layout()
plt.savefig('logc3_vs_flog2.png', dpi=200, bbox_inches='tight')

# --- Print reference values ---
print(f"{'':>30} {'LogC3':>10} {'F-Log2':>10}")
print(f"{'Native V @ 18% gray':>30} {logC3_raw(0.18):>10.4f} {flog2_raw(0.18):>10.4f}")
print(f"{'Native V @ 100% white':>30} {logC3_raw(1.0):>10.4f} {flog2_raw(1.0):>10.4f}")
print(f"{'Native V @ 2% gray':>30} {logC3_raw(0.02):>10.4f} {flog2_raw(0.02):>10.4f}")
print(f"{'V ratio 100%/18%':>30} {logC3_raw(1.0)/logC3_raw(0.18):>10.3f} {flog2_raw(1.0)/flog2_raw(0.18):>10.3f}")

print(f"\nSaved: logc3_vs_flog2.png")
