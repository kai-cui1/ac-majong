import type { ThemeConfig } from 'antd';

/** AntD 5 主题令牌，对齐原型 admin.css（主色 #1677ff、圆角 6、深色侧栏、56px 顶栏） */
export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 6,
    fontSize: 14,
    colorBgLayout: '#f5f5f5',
    colorTextBase: 'rgba(0,0,0,0.88)',
  },
  components: {
    Layout: {
      headerHeight: 56,
      headerPadding: '0 24px',
      headerBg: '#ffffff',
      bodyBg: '#f5f5f5',
      siderBg: '#001529',
    },
    Menu: {
      darkItemBg: '#001529',
      darkSubMenuItemBg: '#000c17',
      darkItemSelectedBg: '#1677ff',
    },
    Card: {
      borderRadiusLG: 8,
    },
  },
};
