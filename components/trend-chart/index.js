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
    endDot: { type: Boolean, value: true },
    // 弹层打开时置 false：画布是原生层，必须从 DOM 里摘掉才盖不住弹层
    visible: { type: Boolean, value: true }
  },

  lifetimes: {
    ready() {
      this._frameId = null;
      this._canvas = null;
      this.render();
    },
    detached() {
      // 组件销毁时把没执行的帧取消掉，别再往已销毁的画布上画
      if (this._frameId !== null && this._canvas && typeof this._canvas.cancelAnimationFrame === 'function') {
        this._canvas.cancelAnimationFrame(this._frameId);
      }
      this._frameId = null;
      this._canvas = null;
    }
  },

  observers: {
    'points, mode, height, showYAxis, direction, lineColor, areaFrom, areaTo, dotColor, gridLines, endDot, visible': function () {
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

        // 同一时刻只保留一个待绘制帧：observers 连续触发会排好几帧，
        // 多画几次既浪费也可能和 canvas 尺寸重设打架。
        if (this._frameId !== null && this._canvas && typeof this._canvas.cancelAnimationFrame === 'function') {
          this._canvas.cancelAnimationFrame(this._frameId);
        }
        this._canvas = canvas;

        const draw = function () {
          // 每次重绘都要重设尺寸（否则画布不会清干净），
          // 然后用 setTransform 设定缩放 —— 它是绝对设置，
          // scale 是累乘，重复渲染会把缩放变成 dpr 的 n 次方。
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          chart.drawSeries(ctx, { width: width, height: height }, options);
        };

        if (typeof canvas.requestAnimationFrame === 'function') {
          this._frameId = canvas.requestAnimationFrame(function () {
            this._frameId = null;
            draw();
          }.bind(this));
        } else {
          draw();
        }
      });
    }
  }
});
