import {useState} from 'react'
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
                    <Typography variant="body2" component="p">
                        {WebApp.initData}
                        {JSON.stringify(WebApp.initDataUnsafe)}
                        {WebApp.version}
                        {WebApp.platform}
                    </Typography>
                </CardContent>
            </Card>
            <div className="card">
                <h2>Powered by</h2>
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
