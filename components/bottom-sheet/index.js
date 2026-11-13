/**
 * 底部弹层
 *
 * 用法：
 *   <bottom-sheet visible="{{sheetVisible}}" title="选择油价地区" scroll-height="84vh" bind:close="onSheetClose">
 *     ...内容...
 *   </bottom-sheet>
 */
Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '' },
    maskClosable: { type: Boolean, value: true },
    /**
     * 内容区（滚动区）的确定高度。
     *
     * ⚠️ scroll-view 必须有确定高度，真机上才滚得动
     * （max-height 对 scroll-view 不生效）。
     * 面板拿到这个高度后，内部的 flex 布局把剩余空间分给滚动区。
     *
     * 长列表（31 个省）用 84vh；
     * 短内容弹层给个小一点的值（40~50vh），别撑成一大块空白。
     */
    scrollHeight: { type: String, value: '84vh' }
  },

  methods: {
    // 阻止弹层内容滚动时背景跟着滚
    noop() {},
    onClose() {
      this.triggerEvent('close');
    },
    onMaskTap() {
      if (this.data.maskClosable) this.triggerEvent('close');
    }
  }
});
