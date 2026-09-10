import React from 'react';
import { Button, Result } from 'antd';

/**
 * 全局错误边界（day2 收尾加固）：antd Modal/Form 之外的渲染异常
 * （如 dev 依赖 re-optimize 触发的瞬态 TDZ）不再导致整页白屏，
 * 提供「重试」软恢复入口。仅兜底渲染期异常，不替代数据层错误处理。
 */
interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error.message, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <Result
          status="error"
          title="页面渲染出错"
          subTitle={this.state.error.message || '发生未知错误'}
          extra={
            <Button type="primary" onClick={this.handleReset}>
              重试
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
