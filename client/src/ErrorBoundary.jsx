import { Component } from "react";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("React interface error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="recovery-page">
          <section className="recovery-card">
            <div className="brand-mark">R</div>
            <h1>The interface hit an error.</h1>
            <p>Your TCP connection and stored messages are safe. Reload the interface to restore the latest state.</p>
            <button className="primary" type="button" onClick={() => window.location.reload()}>Reload interface</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
