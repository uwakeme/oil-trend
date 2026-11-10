Component({
  data: {
    selected: 0,
    list: [
      { path: '/pages/index/index',  text: '油价', icon: '/assets/icons/home-muted.png',   activeIcon: '/assets/icons/home-active.png' },
      { path: '/pages/trend/trend',  text: '走势', icon: '/assets/icons/trend-muted.png',  activeIcon: '/assets/icons/trend-active.png' },
      { path: '/pages/notice/notice',text: '调价', icon: '/assets/icons/notice-muted.png',activeIcon: '/assets/icons/notice-active.png' },
      { path: '/pages/global/global',text: '国际', icon: '/assets/icons/global-muted.png',activeIcon: '/assets/icons/global-active.png' },
      { path: '/pages/alert/alert',  text: '提醒', icon: '/assets/icons/bell-muted.png',   activeIcon: '/assets/icons/bell-active.png' }
    ]
  },

  methods: {
    onTap(e) {
      const { path, index } = e.currentTarget.dataset;
      if (Number(index) === this.data.selected) return;
      wx.switchTab({ url: path });
    }
  }
});
