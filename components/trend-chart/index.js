const chart = require('../../utils/chart');

/**
 * 价格曲线组件（Canvas 2D）
 *
 * properties:
 *   points      [{ date, value }]
 *   mode        'step' | 'line'   step = 价格只在调价日变化（国内油价的正确画法）
 *   height      画布高度（px）
 *   showYAxis   是否显示左侧数值轴
 *   direction   'up' | 'down' | 'flat'  决定配色
 *   lineColor   自定义线条色（可选，覆盖 direction 配色）
 *   gridLines   横向网格线数量
 *   endDot      是否画末端圆点
 */
Component({
  properties: {
    points: { type: Array, value: [] },
    mode: { type: String, value: 'step' },
    height: { type: Number, value: 176 },
    showYAxis: { type: Boolean, value: false },
    direction: { type: String, value: 'flat' },
    lineColor: { type: String, value: '' },
    areaFrom: { type: String, value: '' },
    areaTo: { type: String, value: '' },
    dotColor: { type: String, value: '' },
    gridLines: { type: Number, value: 4 },
    endDot: { type: Boolean, value: true }
  },

  lifetimes: {
    ready() {
      this.render();
    }
  },

  observers: {
    'points, mode, height, showYAxis, direction, lineColor, areaFrom, areaTo, dotColor, gridLines, endDot': function () {
      this.render();
    }
  },

  methods: {
    render() {
      const query = this.createSelectorQuery();
      query.select('#chartCanvas').fields({ node: true, size: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const dpr = (info && info.pixelRatio) || 2;
        const width = res[0].width;
        const height = res[0].height;
        if (!width || !height) return;

        // 每次重绘都要重设尺寸，否则画布不会清干净
        canvas.width = width * dpr;
        canvas.height = height * dpr;

        // 用 setTransform 而不是 scale：
        // setTransform 是绝对设置，scale 是累乘。
        // 组件被重复渲染时（observers 多次触发），
        // 累乘会让缩放变成 dpr 的 n 次方，图形直接画到画布外面去。
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const palette = chart.directionColors(this.data.direction);
        const options = {
          points: this.data.points || [],
          mode: this.data.mode,
          gridLines: this.data.gridLines,
          showYAxis: this.data.showYAxis,
          endDot: this.data.endDot,
          lineColor: this.data.lineColor || palette.lineColor,
          areaFrom: this.data.areaFrom || palette.areaFrom,
          areaTo: this.data.areaTo || palette.areaTo,
          dotColor: this.data.dotColor || chart.COLORS.point,
          yAxisFormat: (v) => v.toFixed(2)
        };

        const draw = function () {
          chart.drawSeries(ctx, { width: width, height: height }, options);
        };
        if (typeof canvas.requestAnimationFrame === 'function') canvas.requestAnimationFrame(draw);
        else draw();
      });
    }
  }
});
