import {useState} from 'react'
import reactLogo from './assets/react.svg'
import twaLogo from './assets/tapps.png'
import viteLogo from '/vite.svg'
import './App.css'
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';

import WebApp from '@twa-dev/sdk'

function App() {
    const [count, setCount] = useState(0)

    return (
        <>
            <Card>
                <CardContent>
                    <Typography variant="body2" component="p">
                        {WebApp.isExpanded ? 'This is an expanded view' : 'This is a compact view'}
                    </Typography>
                </CardContent>
            </Card>
            <div className="card">
                <h2>Powered by</h2>
            </div>
            <div>
                <a href="https://ton.org/dev" target="_blank">
                    <img src={twaLogo} className="logo" alt="TWA logo"/>
                </a>
                <a href="https://vitejs.dev" target="_blank">
                    <img src={viteLogo} className="logo" alt="Vite logo"/>
                </a>
                <a href="https://react.dev" target="_blank">
                    <img src={reactLogo} className="logo react" alt="React logo"/>
                </a>
            </div>
            <h1>TWA + Vite + React</h1>
            <div className="card">
                <button onClick={() => setCount((count) => count + 1)}>
                    count is {count}
                </button>
            </div>
            {/*  */}
            <div className="card">
                <button onClick={() => WebApp.showAlert(`Hello World! Current count is ${count}`)}>
                    Show Alert
                </button>
            </div>
        </>
    )
}

export default App
