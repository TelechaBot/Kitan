import {useState, useEffect} from 'react';

const useGyroscopeExists = () => {
    const [gyroscopeExists, setGyroscopeExists] = useState(false);

    useEffect(() => {
        if (typeof window !== 'undefined' && window.DeviceOrientationEvent) {
            setGyroscopeExists(true);
        }
    }, []);

    return gyroscopeExists;
};

export default useGyroscopeExists;