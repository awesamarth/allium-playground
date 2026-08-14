"use client";

import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  CanvasRenderer,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
]);

export function EChart({ option, ariaLabel }: { option: EChartsCoreOption; ariaLabel: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const chart = echarts.init(container.current, undefined, { renderer: "canvas" });
    chart.setOption(option, { notMerge: true });
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      chart.dispose();
    };
  }, [option]);

  return <div className="allium-chart" ref={container} role="img" aria-label={ariaLabel} />;
}
