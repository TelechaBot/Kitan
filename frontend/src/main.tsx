import React, { DispatchWithoutAction, FC, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  useThemeParams,
  WebAppProvider,
  useInitData,
  useWebApp,

} from '@vkruglikov/react-telegram-web-app';
import { ConfigProvider, theme } from 'antd';
import 'antd/dist/reset.css';

import './index.css';
import logo from './logo.svg';

import MainButtonDemo from './MainButtonDemo';
import BackButtonDemo from './BackButtonDemo';
import ShowPopupDemo from './ShowPopupDemo';
import HapticFeedbackDemo from './HapticFeedbackDemo';
import ScanQrPopupDemo from './ScanQrPopupDemo';
import ExpandDemo from './ExpandDemo';
import useBetaVersion from './useBetaVersion';

const DemoApp: FC<{
  onChangeTransition: DispatchWithoutAction;
}> = ({ onChangeTransition }) => {
  const [colorScheme, themeParams] = useThemeParams();
  const [isBetaVersion, handleRequestBeta] = useBetaVersion(false);
  const [activeBtn, setActiveBtn] = useState(true);
  const [initDataUnsafe, initData] = useInitData();
  const WebApp = useWebApp();

  console.log(WebApp.version);
  console.log('initData', initData);
  console.log('initDataUnsafe', initDataUnsafe);
  return (
    <div>
      <ConfigProvider
        theme={
          themeParams.text_color
            ? {
                algorithm:
                  colorScheme === 'dark'
                    ? theme.darkAlgorithm
                    : theme.defaultAlgorithm,
                token: {
                  colorText: themeParams.text_color,
                  colorPrimary: themeParams.button_color,
                  colorBgBase: themeParams.bg_color,
                },
              }
            : undefined
        }
      >
        <header className="App-header">
          <img
            onClick={handleRequestBeta}
            src={logo}
            className="App-logo"
            alt="logo"
          />
        </header>
        <div className="contentWrapper">
          {isBetaVersion && (
            <div className="betaVersion">
              <h3>WARNING: BETA VERSION</h3>
              <button onClick={() => setActiveBtn(state => !state)}>
                change button
              </button>
              <button onClick={onChangeTransition}>change </button>
            </div>
          )}
          <ExpandDemo />
          {!activeBtn ? (
            <MainButtonDemo
              initialValues={{
                show: isBetaVersion,
                text: 'SECOND BUTTON',
                progress: true,
              }}
              key="1"
            />
          ) : (
            <MainButtonDemo
              key="2"
              initialValues={{
                show: isBetaVersion,
              }}
            />
          )}
          <span>WebApp version: {WebApp.version}</span>
          <span>WebApp version: {WebApp.platform}</span>
          <span>initData: {JSON.stringify(initData)}</span>
          <span>initDataUnsafe: {JSON.stringify(initDataUnsafe)}</span>

          <BackButtonDemo />
          <ShowPopupDemo />
          <HapticFeedbackDemo />
          <ScanQrPopupDemo />
        </div>
      </ConfigProvider>
    </div>
  );
};

const App = () => {
  const [smoothButtonsTransition, setSmoothButtonsTransition] = useState(false);

  return (
    <WebAppProvider options={{ 
      smoothButtonsTransition 
      }}>
      <DemoApp
        onChangeTransition={() => setSmoothButtonsTransition(state => !state)}
      />
    </WebAppProvider>
  );
};
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
